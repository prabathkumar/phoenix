/**
 * LLM refinement layer (docs/PHOENIX_SPEC.md §4.3's "stage 2 follow-up"
 * TODOs in pipeline.js) — an optional, best-effort pass over the
 * rule-based output of inferTestName()/inferAssertions(), backed by a
 * local Ollama instance rather than a hosted API (Prabath runs Llama
 * locally; nothing here talks to a network LLM provider).
 *
 * Contract: every function here takes the rule-based result as an
 * input alongside the raw material, and returns either a refined
 * result or, on ANY failure (Ollama not running, timeout, malformed
 * response, unexpected exception), the untouched rule-based input it
 * was given. Callers never need their own try/catch — refineTestName()
 * and filterAssertions() cannot throw. This is what "guaranteed
 * fallback" means here: refinement can only improve the output or
 * leave it exactly as the v1 pipeline already produced it, never break
 * it or leave it half-applied.
 *
 * pipeline.js's shape and output contract (generateScript's return
 * value) do not change when this is wired in — see its call site.
 */

const OLLAMA_HOST = process.env.PHOENIX_OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.PHOENIX_OLLAMA_MODEL || "llama3";
const TIMEOUT_MS = Number(process.env.PHOENIX_LLM_TIMEOUT_MS) || 8000;

/**
 * Calls Ollama's /api/generate with a prompt that asks for a single
 * JSON value back, and parses it. Any failure along the way (network,
 * timeout, non-200, unparseable response, response that isn't the
 * shape the caller expects) surfaces as a thrown error — callers here
 * always catch it and fall back, this function itself does not.
 *
 * @param {string} prompt
 * @param {Object} [options]
 * @param {string[]} [options.images] - base64-encoded image data (no
 *   data: URI prefix), passed through to Ollama's `images` field for a
 *   multimodal-capable model (e.g. llava, or a vision-tuned llama3.2
 *   build) — see generation/semantic-act.js's fused (text + screenshot)
 *   resolution, docs/PHOENIX_SPEC.md §6's "grounded screen snapshot:
 *   merge accessibility tree + screenshot" bullet. Omitted entirely
 *   when not given, so a plain text-only model (the existing default)
 *   is unaffected either way — Ollama simply never sees an `images`
 *   key it wasn't sent. Passing images to a model that can't use them
 *   is between the caller and PHOENIX_OLLAMA_MODEL's configuration;
 *   this function doesn't validate model capability, it only sends
 *   what it was given.
 */
async function callOllamaJson(prompt, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const requestBody = {
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format: "json",
    };
    if (options.images && options.images.length > 0) {
      requestBody.images = options.images;
    }

    const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama responded with status ${response.status}`);
    }

    const body = await response.json();
    // Ollama's non-streaming /api/generate wraps the model's own output
    // string in `.response` — that string is itself the JSON we asked
    // the model to produce (format: "json" constrains the model's
    // output, it doesn't restructure Ollama's own envelope).
    if (typeof body.response !== "string") {
      throw new Error("Ollama response missing expected 'response' field");
    }

    return JSON.parse(body.response);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refines the rule-based flow name (first-screen-title-derived) into a
 * name that summarizes the whole recorded flow, using the sequence of
 * on-screen labels the tester actually interacted with as context.
 *
 * @param {import('../capture/recorder').CapturedStep[]} steps
 * @param {string} ruleBasedName
 * @returns {Promise<string>} the refined name, or ruleBasedName unchanged on any failure
 */
async function refineTestName(steps, ruleBasedName) {
  try {
    const { extractLabels } = require("./pipeline");
    const screenSummaries = steps.map((step, i) => {
      const labels = extractLabels(step.pageSourceBefore).slice(0, 8).map((l) => l.label);
      return `Step ${i + 1} screen: ${labels.join(", ") || "(no labels captured)"}`;
    });

    const prompt = [
      "You are naming an automated mobile test case from a recorded user flow.",
      "Given the on-screen labels visible at each step, produce a short",
      "snake_case test name (2-6 words) summarizing the whole flow, not just",
      "the first screen. Respond with ONLY a JSON object: {\"name\": \"...\"}.",
      "",
      `Fallback name already available if you can't do better: "${ruleBasedName}"`,
      "",
      ...screenSummaries,
    ].join("\n");

    const result = await callOllamaJson(prompt);
    const name = result && typeof result.name === "string" ? result.name.trim() : "";
    const normalized = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");

    return normalized || ruleBasedName;
  } catch (err) {
    console.warn("[generation/llm] refineTestName falling back to rule-based name:", err.message);
    return ruleBasedName;
  }
}

/**
 * Filters the rule-based assertion list down to the ones that reflect a
 * meaningful, intentional UI change — dropping incidental noise a
 * before/after diff can't distinguish on its own (a clock or a battery
 * indicator ticking over, a loading spinner's label, an ad banner
 * rotating) while keeping everything genuinely tied to the tap that
 * produced it.
 *
 * This can only ever remove candidates the rule-based pass proposed,
 * never invent new ones the accessibility-tree diff didn't already
 * find — refinement narrows, it doesn't fabricate.
 *
 * @param {import('./pipeline').Assertion[]} ruleBasedAssertions
 * @returns {Promise<import('./pipeline').Assertion[]>} filtered list, or the input unchanged on any failure
 */
async function filterAssertions(ruleBasedAssertions) {
  if (ruleBasedAssertions.length === 0) return ruleBasedAssertions;

  try {
    const numbered = ruleBasedAssertions.map((a, i) => `${i}: "${a.label}"`).join("\n");
    const prompt = [
      "You are reviewing candidate test assertions generated from a mobile",
      "UI diff (a label that newly appeared on screen after a tap). Some of",
      "these are meaningful confirmations that the tap worked; others are",
      "incidental noise unrelated to the tap (a clock, battery/signal",
      "indicator, ad banner, loading spinner, or other label that changes",
      "on its own regardless of user action).",
      "",
      "Respond with ONLY a JSON object: {\"keepIndexes\": [0, 2, ...]} listing",
      "the indexes (from the list below) of assertions worth keeping. When in",
      "doubt, keep it — only drop assertions you're confident are noise.",
      "",
      numbered,
    ].join("\n");

    const result = await callOllamaJson(prompt);
    if (!result || !Array.isArray(result.keepIndexes)) {
      throw new Error("Ollama response missing expected 'keepIndexes' array");
    }

    const keep = new Set(result.keepIndexes.filter((i) => Number.isInteger(i)));
    if (keep.size === 0) {
      // A model that filtered everything out is more likely wrong than
      // right — trust the rule-based diff over an empty verdict.
      throw new Error("refinement would drop every assertion, discarding its verdict");
    }

    return ruleBasedAssertions.filter((_, i) => keep.has(i));
  } catch (err) {
    console.warn("[generation/llm] filterAssertions falling back to unfiltered rule-based list:", err.message);
    return ruleBasedAssertions;
  }
}

module.exports = { refineTestName, filterAssertions, callOllamaJson };
