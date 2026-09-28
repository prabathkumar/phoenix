/**
 * Semantic action layer (docs/PHOENIX_SPEC.md §6, Phase 2 — "AI-native
 * semantic layer"). Second building block of the unattended/semantic
 * track, built directly on top of semantic-snapshot.js's grounded
 * snapshot: given a plain-language instruction like
 * `act("tap the Login button")` and a snapshot of the current screen,
 * asks the local Ollama model to pick which element (by ref) the
 * instruction refers to, and resolves that back into a concrete
 * WebDriver locator the engine can act on.
 *
 * This mirrors generation/llm.js's contract deliberately: it's the same
 * local-Ollama, fail-safe pattern already proven there for
 * refineTestName()/filterAssertions(). The difference here is that
 * there is no rule-based fallback *result* to fall back to (there is no
 * v1 rule for "which element does 'the Login button' mean") — so on any
 * failure resolveSemanticAction() returns a structured "unresolved"
 * result instead of guessing. Per docs/PHOENIX_SPEC.md §2's whole
 * argument for guided-first, a wrong guess here (tapping the wrong
 * element unattended) is worse than stopping and saying so; callers are
 * expected to treat an unresolved action as "stop and hand back to a
 * human," which is also exactly the Phase 3 autonomous-loop contract
 * this is laying groundwork for.
 *
 * Not wired into any live session yet — this module only resolves an
 * instruction against an already-captured snapshot; actually issuing
 * the resulting tap/setValue against a live Appium session is future
 * work (engine/ owns session actions today, see session-manager.js).
 */

const { buildGroundedSnapshot, snapshotToText, findByRef } = require("./semantic-snapshot");
const { callOllamaJson } = require("./llm");

/**
 * @typedef {Object} SemanticActionResult
 * @property {boolean} resolved
 * @property {import('./semantic-snapshot').SnapshotElement} [element] - present when resolved
 * @property {{strategy: string, value: string}} [selector] - present when
 *   resolved; strategy is "resource-id", "accessibility-id", or "text",
 *   matching the strategy names buildSelector() in pipeline.js already
 *   understands, so a resolved action's selector can be fed straight
 *   into the same selector-building code the guided path uses.
 * @property {string} [reason] - present when NOT resolved: why (no
 *   snapshot elements, Ollama unavailable, model declined to match,
 *   named a ref that doesn't exist in this snapshot).
 */

/**
 * Turns a resolved snapshot element into the same {strategy, value}
 * shape pipeline.js's buildSelector() consumes, in the same priority
 * order the rule-based guided path already uses (resource-id first,
 * then accessibility-id, then visible text) -- Act 2 targets the same
 * kind of stable locator Act 1 does, it just picks the element
 * differently.
 *
 * @param {import('./semantic-snapshot').SnapshotElement} element
 * @returns {{strategy: string, value: string}|undefined}
 */
function toSelector(element) {
  if (element.resourceId) return { strategy: "resource-id", value: element.resourceId };
  if (element.accessibilityId) return { strategy: "accessibility-id", value: element.accessibilityId };
  if (element.label) return { strategy: "text", value: element.label };
  return undefined;
}

/**
 * Resolves a natural-language instruction against a captured screen.
 *
 * @param {string} pageSourceXml - same input buildGroundedSnapshot() and
 *   pipeline.js's extractLabels() take.
 * @param {string} instruction - e.g. "tap the Login button".
 * @returns {Promise<SemanticActionResult>}
 */
async function resolveSemanticAction(pageSourceXml, instruction) {
  const elements = buildGroundedSnapshot(pageSourceXml);

  if (elements.length === 0) {
    return { resolved: false, reason: "grounded snapshot has no labeled/identified elements to act on" };
  }

  try {
    const prompt = [
      "You are resolving a natural-language mobile test instruction against",
      "a snapshot of the elements currently visible on screen. Each line is",
      "one candidate element: [ref] role \"label\" (identifiers).",
      "",
      `Instruction: "${instruction}"`,
      "",
      "Snapshot:",
      snapshotToText(elements),
      "",
      "Respond with ONLY a JSON object. If exactly one element is a confident",
      'match for the instruction, respond {"ref": <number>}. If no element',
      "is a confident match -- the instruction is ambiguous, refers to",
      "nothing on screen, or you're not sure -- respond",
      '{"ref": null, "reason": "..."} instead of guessing.',
    ].join("\n");

    const result = await callOllamaJson(prompt);

    if (!result || (result.ref !== null && !Number.isInteger(result.ref))) {
      throw new Error("Ollama response missing expected 'ref' field");
    }

    if (result.ref === null) {
      const reason = typeof result.reason === "string" && result.reason.trim()
        ? result.reason.trim()
        : "model did not find a confident match";
      return { resolved: false, reason };
    }

    const element = findByRef(elements, result.ref);
    if (!element) {
      // The model named a ref outside this snapshot -- treat as
      // unresolved rather than trusting a reference that can't be
      // verified against what's actually on screen (see module header:
      // no guessing).
      return { resolved: false, reason: `model referenced ref ${result.ref}, which is not in this snapshot` };
    }

    const selector = toSelector(element);
    if (!selector) {
      // Shouldn't happen -- every snapshot element has a label, id, or
      // accessibility id by construction (see semantic-snapshot.js) --
      // but stay unresolved rather than acting on an unusable selector.
      return { resolved: false, reason: `ref ${result.ref} has no usable selector` };
    }

    return { resolved: true, element, selector };
  } catch (err) {
    console.warn("[generation/semantic-act] resolveSemanticAction failed, returning unresolved:", err.message);
    return { resolved: false, reason: `resolution failed: ${err.message}` };
  }
}

module.exports = { resolveSemanticAction, toSelector };
