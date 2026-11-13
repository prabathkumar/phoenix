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
const { parseRepeat, mismatch, domMatch, plainName, enterTarget, MATCH_RULES } = require("./named-target");

/** One plain click, not a multi-part goal such as "go to X and click Y". */
const isSingleClick = (g) => /^\s*(click|tap|press|select|choose|pick)\b/i.test(g) && !/\b(and|then|after|before)\b|[,;]/i.test(String(g).replace(/^\s*(click|tap|press|select|choose|pick)\s+(on\s+)?/i, ""));

/** One value into one field, not a multi-part goal. */
const isSingleEntry = (g) => /^\s*(enter|type|fill|input)\b/i.test(g) && !/\b(and then|then|after|before)\b|[;]/i.test(String(g));

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
    MATCH_RULES,
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
/** Messages that mean the site will not let this purchase journey continue (checked before each step, except steps that are themselves checks). */
const HARD_BLOCKER = /(sold out online|out of stock|stock temporarily reserved|temporarily reserved|currently unavailable|join waitlist|coming soon)/i;

async function runGoalLoopInner(surface, goal, opts = {}) {
  assertSurface(surface);
  const callModel = opts.callModel || require("../../generation/llm").callOllamaJson;
  const maxSteps = opts.maxSteps || 12;
  const rep = parseRepeat(goal); // "click the logo 10 times": the runner repeats, the model resolves once
  const namedGoal = goal;
  goal = rep.text;
  const progress = opts.onProgress || (() => {});
  const startOrigin = (() => { try { return new URL(surface.url()).origin; } catch { return ""; } })();
  const allowed = new Set([startOrigin, ...(opts.allowedOrigins || [])].filter(Boolean));

  const history = [];
  const steps = [];
  const actions = [];
  const excluded = new Set();
  let lastKey = "";
  const tapped = new Map(); // what was already tapped for this goal: going back to it is going in circles
  let stuck = 0;
  let note = "";
  let pageNote = ""; // set when the page differs from the remembered one

  for (let n = 0; n < maxSteps; n += 1) {
    let all;
    for (let tryN = 0; ; tryN += 1) { // a page that navigates mid-read ("Execution context was destroyed") is read again, not failed
      try { all = await surface.snapshot(); break; }
      catch (err) { if (tryN >= 3 || !/context was destroyed|navigat|Target closed|detached/i.test(String(err && err.message))) throw err; await new Promise((r) => setTimeout(r, opts.blockedWaitMs ?? 700)); }
    }
    let elements = all.filter((e) => !excluded.has(e.ref));
    const before = await surface.lines();
    let image;
    if (opts.vision) { try { image = await surface.screenshot(); } catch { /* no screenshot */ } }

    let decision;
    const typed = n === 0 ? enterTarget(goal, elements) : null; // "Enter 0102... in the mobile number field": read the page
    let dom = n === 0 ? (domMatch(goal, elements) || plainName(goal, elements)) : null; // "click Buy now on the vivo X500": read the card, no model needed
    // Choices often appear a moment after the previous tap (contract period after the plan): if nothing matched yet, look again briefly before asking the model.
    for (let settle = 0; n === 0 && !typed && !(dom && (dom.element || dom.blocked)) && settle < 3; settle += 1) {
      await new Promise((r) => setTimeout(r, opts.blockedWaitMs ?? 700));
      elements = (await surface.snapshot()).filter((e) => !excluded.has(e.ref));
      dom = domMatch(goal, elements) || plainName(goal, elements);
    }
    if (n === 0 && !/^\s*(check|verify|assert|expect|see|confirm|make sure)\b/i.test(goal)) { // the site itself says the product cannot be bought: say so now, do not hunt for other controls
      try {
        const hard = (await surface.lines()).map((l) => String(l).trim()).filter((l) => l && l.length <= 160 && HARD_BLOCKER.test(l));
        if (hard.length) return { success: false, reason: `the site stopped the journey - the page is showing: "${[...new Set(hard)].slice(0, 2).join(" / ")}"`, steps, actions };
      } catch { /* page text is a bonus */ }
    }
    if (n === 0 && opts.pageMemory) { // remember this page state; say so if the page is not what it was last time
      try { const said = opts.pageMemory(surface.url(), elements); if (said) { pageNote = said; if (opts.pageNotes) opts.pageNotes.push(said); progress({ message: `note: ${said}` }); } } catch { /* memory never fails a step */ }
    }
    // A button is often enabled a moment after the choice that unlocks it: look again for a few seconds before calling it disabled.
    for (let wait = 0; dom && dom.blocked && wait < 6; wait += 1) {
      await new Promise((r) => setTimeout(r, opts.blockedWaitMs ?? 700));
      elements = (await surface.snapshot()).filter((e) => !excluded.has(e.ref));
      dom = domMatch(goal, elements) || plainName(goal, elements);
    }
    if (dom && dom.blocked) return { success: false, reason: dom.why, steps, actions }; // the named control is there but disabled: say so, do not click something else
    if (typed) { decision = { action: "type", ref: typed.element.ref, text: typed.text }; history.push(`page read: ${typed.why}`); }
    else if (dom && dom.element) { decision = { action: "tap", ref: dom.element.ref }; history.push(`page read: ${dom.why}`); }
    else try {
      if (dom) note = dom.why;
      decision = await callModel(buildPrompt({ goal, elements, lines: before, history, note, hasImage: Boolean(image) }), image ? { images: [image] } : {});
    } catch (err) {
      return { success: false, reason: `model call failed: ${err.message}`, steps, actions };
    }
    note = "";
    if (!decision || typeof decision.action !== "string") return { success: false, reason: "model gave no valid action", steps, actions };

    if (decision.action === "done") return { success: true, reason: String(decision.reason || "goal reached"), steps, actions };
    if (/^(none|nothing|null|no|cannot|can't|unknown|n\/a)$/i.test(decision.action)) return { success: false, reason: String(decision.reason || `the model found nothing on the page matching "${goal}"`), steps, actions };
    if (decision.action === "fail") return { success: false, reason: String(decision.reason || "model gave up"), steps, actions };

    const kind = { tap: "tap", type: "type", select: "select", press: "press", scroll: "scroll", navigate: "navigate" }[decision.action];
    if (!kind) return { success: false, reason: `unknown action "${decision.action}"`, steps, actions };

    const needsRef = ["tap", "type", "select"].includes(kind);
    const element = needsRef ? elements.find((e) => e.ref === decision.ref) : null;
    if (needsRef && !element) { note = `ref ${decision.ref} is not in the list; choose from the list.`; stuck += 1; if (stuck >= 3) break; continue; }
    const wrong = needsRef ? mismatch(namedGoal, element) : null;
    if (wrong) { note = `${wrong}. Choose the element that is actually named, or fail if it is not on the page.`; excluded.add(element.ref); stuck += 1; if (stuck >= 3) return { success: false, reason: wrong, steps, actions }; continue; }
    if (kind === "tap" && rep.times === 1) {
      const who = `${element.role}|${String(element.name || "").toLowerCase()}`;
      if ((tapped.get(who) || 0) >= 1) { note = `"${element.name}" was already tapped and did not reach the goal. Pick something else, or fail if the named thing is not on the page.`; excluded.add(element.ref); stuck += 1; if (stuck >= 3) return { success: false, reason: `went in circles (kept choosing "${element.name}"); the thing asked for may not be on the page`, steps, actions }; continue; }
      tapped.set(who, 1);
    }
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

    if (rep.times > 1 && kind === "tap") {
      // same element, again: no re-guessing, no "stuck" exclusion (a logo click may change nothing)
      let done = 1, why = "";
      for (; done < rep.times; done += 1) { const again = await surface.perform(perform); if (!again.ok) { why = again.reason; break; } }
      progress({ message: `${label} x${done}`, step: n + 1 });
      return why
        ? { success: false, reason: `clicked "${element.name || element.role}" ${done} of ${rep.times} times, then: ${why}`, steps, actions }
        : { success: true, reason: `clicked "${element.name || element.role}" ${rep.times} times`, steps, actions };
    }
    if (kind === "type" && isSingleEntry(goal)) { // one value into one field: done once it has been typed
      return { success: true, reason: `typed into "${element.name || element.role}"`, steps, actions };
    }
    if (kind === "tap" && isSingleClick(goal)) {
      // "Click the Devices menu" is one action: once it has been done, the step is done. Do not keep going and re-tap it.
      return { success: true, reason: `clicked "${element.name || element.role}"${changed ? "" : " (no visible change)"}`, steps, actions };
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


/** Messages a site shows when it will not let the journey continue (a pop-up, a banner): the tester needs the site's own words, not a locator mismatch. */
const BLOCKER = /(temporarily reserved|out of stock|sold out|unavailable|not available|something went wrong|try again|please check again|error|failed|session (has )?expired|access denied|too many requests|maintenance)/i;

async function runGoalLoop(surface, goal, opts = {}) {
  const r = await runGoalLoopInner(surface, goal, opts);
  if (r.success) return r;
  try {
    const seen = (await surface.lines()).map((l) => String(l).trim()).filter((l) => l && l.length <= 160 && BLOCKER.test(l));
    if (seen.length) return { ...r, reason: `${r.reason} - the page is showing: "${[...new Set(seen)].slice(0, 2).join(" / ")}"` };
  } catch { /* the page text is a bonus, never a reason to fail differently */ }
  return r;
}

module.exports = { runGoalLoop, RISKY_RE };
