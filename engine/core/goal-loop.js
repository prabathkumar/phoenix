/**
 * AI layer, written once against a Surface: given a goal in plain language,
 * look at the screen, pick ONE next action, do it, check what changed, repeat.
 *
 * Output is not just "did it work": every action is returned as a PROPOSED
 * step (with a verified selector) plus evidence, so a successful loop can be
 * promoted back up into the Synthetic layer - as a patch the tester approves.
 *
 * Guards: step budget, stuck detection (same action twice without a visible
 * change -> exclude that element, then stop), cross-origin navigation refused,
 * and a list of risky words (pay, delete, ...) that stops the loop for a human.
 */
const { assertSurface, diffLines } = require("./surface");
const { snapshotToText } = require("./semantic-resolve");

const RISKY_RE = /\b(delete|remove account|pay now|place order|confirm payment|purchase|cancel subscription|deactivate|terminate)\b/i;

function buildPrompt({ goal, elements, lines, history, note, hasImage }) {
  return [
    "You are driving a web or mobile app to reach a goal, ONE action at a time.",
    `Goal: ${goal}`,
    "",
    history.length ? "Actions so far:\n" + history.map((h, i) => `${i + 1}. ${h}`).join("\n") : "No actions yet.",
    note ? `\nNote: ${note}` : "",
    "",
    "Visible text (top):",
    lines.slice(0, 40).map((l) => `- ${l}`).join("\n"),
    "",
    "Elements you can act on:",
    snapshotToText(elements),
    hasImage ? "\nA screenshot is attached; use it to understand the layout. Act only on refs from the list." : "",
    "",
    "Choose the single next action. Respond with ONLY JSON, one of:",
    '{"action":"tap","ref":<n>}  {"action":"type","ref":<n>,"text":"..."}  {"action":"select","ref":<n>,"option":"<visible label>"}',
    '{"action":"press","key":"Enter"}  {"action":"scroll","direction":"down"|"up"}  {"action":"navigate","url":"..."}',
    '{"action":"done","reason":"<why the goal is met>"}  {"action":"fail","reason":"<why it cannot be met>"}',
    "Say done only when the screen shows the goal achieved. Never invent refs. Never type secrets you were not given.",
  ].filter((l) => l !== "").join("\n");
}

const actionKey = (a) => `${a.action}|${a.ref ?? ""}|${a.text ?? a.option ?? a.key ?? a.url ?? a.direction ?? ""}`;

/**
 * @param {Object} surface
 * @param {string} goal
 * @param {{maxSteps?:number, vision?:boolean, callModel?:Function, onProgress?:Function,
 *          allowRisky?:boolean, allowedOrigins?:string[], testData?:Object}} [opts]
 * @returns {Promise<{success:boolean, reason:string, steps:Object[], actions:Object[]}>}
 */
async function runGoalLoop(surface, goal, opts = {}) {
  assertSurface(surface);
  const callModel = opts.callModel || require("../../generation/llm").callOllamaJson;
  const maxSteps = opts.maxSteps || 12;
  const progress = opts.onProgress || (() => {});
  const startOrigin = (() => { try { return new URL(surface.url()).origin; } catch { return ""; } })();
  const allowed = new Set([startOrigin, ...(opts.allowedOrigins || [])].filter(Boolean));

  const history = [];
  const steps = [];
  const actions = [];
  const excluded = new Set();
  let lastKey = "";
  let stuck = 0;
  let note = "";

  for (let n = 0; n < maxSteps; n += 1) {
    const all = await surface.snapshot();
    const elements = all.filter((e) => !excluded.has(e.ref));
    const before = await surface.lines();
    let image;
    if (opts.vision) { try { image = await surface.screenshot(); } catch { /* no screenshot */ } }

    let decision;
    try {
      decision = await callModel(buildPrompt({ goal, elements, lines: before, history, note, hasImage: Boolean(image) }), image ? { images: [image] } : {});
    } catch (err) {
      return { success: false, reason: `model call failed: ${err.message}`, steps, actions };
    }
    note = "";
    if (!decision || typeof decision.action !== "string") return { success: false, reason: "model gave no valid action", steps, actions };

    if (decision.action === "done") return { success: true, reason: String(decision.reason || "goal reached"), steps, actions };
    if (decision.action === "fail") return { success: false, reason: String(decision.reason || "model gave up"), steps, actions };

    const kind = { tap: "tap", type: "type", select: "select", press: "press", scroll: "scroll", navigate: "navigate" }[decision.action];
    if (!kind) return { success: false, reason: `unknown action "${decision.action}"`, steps, actions };

    const needsRef = ["tap", "type", "select"].includes(kind);
    const element = needsRef ? elements.find((e) => e.ref === decision.ref) : null;
    if (needsRef && !element) { note = `ref ${decision.ref} is not in the list; choose from the list.`; stuck += 1; if (stuck >= 3) break; continue; }
    if (needsRef && element.disabled) { note = `"${element.name}" is disabled.`; excluded.add(element.ref); continue; }
    if (kind === "type" && !element.editable) { note = `"${element.name}" is not an editable field.`; excluded.add(element.ref); continue; }
    if (kind === "navigate") {
      let origin = "";
      try { origin = new URL(decision.url, surface.url()).origin; } catch { /* invalid */ }
      if (!allowed.has(origin)) return { success: false, reason: `refused to navigate away to ${decision.url}`, steps, actions };
    }
    if (needsRef && !opts.allowRisky && RISKY_RE.test(element.name || "")) {
      return { success: false, reason: `stopped before "${element.name}" - it looks irreversible; needs a person to confirm`, steps, actions };
    }

    const key = actionKey(decision);
    // Locator for the proposed step, taken BEFORE acting (the page may change after).
    const located = needsRef ? await surface.selectorFor(element.ref) : { selector: null, fragile: false };
    const perform = { kind, ...(needsRef ? { ref: element.ref } : {}), ...(decision.text !== undefined ? { text: String(decision.text) } : {}), ...(decision.option !== undefined ? { option: String(decision.option) } : {}), ...(decision.key ? { key: String(decision.key) } : {}), ...(kind === "scroll" ? { direction: decision.direction === "up" ? "up" : "down" } : {}), ...(kind === "navigate" ? { url: new URL(decision.url, surface.url()).toString() } : {}) };
    const res = await surface.perform(perform);
    const label = element ? `${kind} "${element.name || element.role}"` : kind === "navigate" ? `navigate ${perform.url}` : kind === "press" ? `press ${perform.key}` : kind;
    if (!res.ok) { history.push(`${label} -> FAILED: ${res.reason}`); note = `last action failed: ${res.reason}`; if (element) excluded.add(element.ref); stuck += 1; if (stuck >= 3) break; continue; }

    const after = await surface.lines();
    const diff = diffLines(before, after);
    const changed = diff.appeared.length > 0 || diff.disappeared.length > 0;
    history.push(`${label} -> ${changed ? "page changed" : "no visible change"}`);
    progress({ message: label, step: n + 1 });
    actions.push({ label, kind, changed });

    if (kind !== "scroll") {
      const step = { kind, instruction: element ? `${kind === "type" ? "Type into" : kind === "select" ? "Select in" : "Click"} ${element.name || element.role}` : label };
      if (located.selector) step.selector = located.selector;
      if (kind === "type") step.text = perform.text;
      if (kind === "select") step.option = perform.option;
      if (kind === "press") step.key = perform.key;
      if (kind === "navigate") step.url = perform.url;
      steps.push({ step, evidence: { changed, appeared: diff.appeared.slice(0, 3), fragile: located.fragile } });
    }

    if (key === lastKey && !changed) {
      stuck += 1;
      if (element) excluded.add(element.ref);
      note = "that did nothing visible; try a different element or a different approach.";
      if (stuck >= 2) return { success: false, reason: "stuck: the same action changed nothing", steps, actions };
    } else if (changed) stuck = 0;
    lastKey = key;
  }
  return { success: false, reason: `did not reach the goal within ${maxSteps} actions`, steps, actions };
}

module.exports = { runGoalLoop, RISKY_RE };
