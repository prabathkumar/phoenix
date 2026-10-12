/**
 * The ladder: what happens when the Synthetic layer (the recorded locator)
 * cannot act. Falls DOWN one rung at a time, and every rung that rescues the
 * step also returns a PATCH proposing how to promote the fix back UP into the
 * Synthetic layer. Patches are evidence-gated and never applied silently.
 *
 *   Synthetic  recorded selector                      (caller tries this first)
 *   Semantic   plain-language instruction -> element, with the vision add-on
 *   AI         goal loop toward the instruction's intent -> proposed new steps
 *   Guided     a person picks/fixes it (hook), the answer becomes the new selector
 *
 * Each rung is told what failed so far: the dead selector, the page diff, and
 * the failures already seen in this run.
 */
const { resolveByInstruction } = require("../engine/core/semantic-resolve");
const { runGoalLoop } = require("../engine/core/goal-loop");
const { diffLines } = require("../engine/core/surface");
const { verifyExpectedOutcome } = require("../generation/outcome-verification");

const LAYERS = ["synthetic", "semantic", "ai", "guided"];

function actionFor(step, ref) {
  return {
    kind: step.kind,
    ref,
    ...(step.kind === "type" ? { text: step.text } : {}),
    ...(step.kind === "select" ? { option: step.option } : {}),
  };
}

/** Did the action have evidence it did the right thing? (gates promotion) */
function evidenceOf(step, diff, verification) {
  return {
    expectPassed: Boolean(step.expect) && verification.ok,
    pageChanged: diff.appeared.length > 0 || diff.disappeared.length > 0,
    typed: step.kind === "type",
  };
}
const hasEvidence = (e) => e.expectPassed || e.pageChanged || e.typed;

async function trySemantic(surface, step, ctx, options) {
  const kind = step.kind === "type" ? "type" : step.kind === "select" ? "select" : "tap";
  const exclude = [];
  let lastReason = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await resolveByInstruction(surface, step.instruction, {
      kind, exclude, vision: options.vision !== false, callModel: options.callModel,
      context: { failedSelector: ctx.failedSelector, reason: ctx.reason, pageDiff: ctx.pageDiff, pastFailures: ctx.pastFailures },
    });
    if (!res.resolved) return { ok: false, reason: res.reason };
    const located = await surface.selectorFor(res.ref);
    const before = await surface.lines();
    const act = await surface.perform(actionFor(step, res.ref));
    if (!act.ok) { exclude.push(res.ref); lastReason = act.reason; continue; }
    const diff = diffLines(before, await surface.lines());
    const verification = step.expect ? verifyExpectedOutcome({ appeared: diff.appeared.map((label) => ({ label })), disappeared: diff.disappeared.map((label) => ({ label })) }, step.expect) : { ok: true };
    if (!verification.ok) { exclude.push(res.ref); lastReason = verification.reason; continue; }
    const evidence = evidenceOf(step, diff, verification);
    // A click that changed nothing may have hit a look-alike: try once more without it.
    if (step.kind === "tap" && !step.expect && !evidence.pageChanged && attempt === 0) { exclude.push(res.ref); lastReason = "no visible change"; continue; }
    return { ok: true, layer: "semantic", selector: located.selector, fragile: located.fragile, evidence, usedVision: res.usedVision };
  }
  return { ok: false, reason: lastReason || "semantic layer could not act" };
}

/**
 * @param {Object} p
 * @param {Object} p.surface @param {Object} p.step @param {number} p.index
 * @param {{failedSelector?:Object, reason?:string, pageDiff?:Object, pastFailures?:Object[]}} p.ctx
 * @param {{ai?:boolean, vision?:boolean, callModel?:Function, onGuided?:Function, onProgress?:Function}} p.options
 * @returns {Promise<{ok:boolean, layer?:string, patch?:Object, reason?:string, tried:string[]}>}
 */
async function climbLadder({ surface, step, index, ctx = {}, options = {} }) {
  const tried = [];
  const reasons = [];

  tried.push("semantic");
  const sem = await trySemantic(surface, step, ctx, options);
  if (sem.ok) {
    const promotable = hasEvidence(sem.evidence) && sem.selector && !sem.fragile;
    return {
      ok: true, layer: "semantic", tried, usedVision: sem.usedVision,
      patch: { index, layer: "semantic", from: ctx.failedSelector, to: sem.selector, fragile: sem.fragile, evidence: sem.evidence, promotable, instruction: step.instruction },
    };
  }
  reasons.push(`semantic: ${sem.reason}`);

  if (options.ai) {
    tried.push("ai");
    const loop = await runGoalLoop(surface, step.instruction, { vision: options.vision !== false, callModel: options.callModel, onProgress: options.onProgress });
    if (loop.success) {
      return {
        ok: true, layer: "ai", tried,
        patch: { index, layer: "ai", from: ctx.failedSelector, replaceWith: loop.steps.map((s) => s.step), evidence: loop.steps.map((s) => s.evidence), promotable: loop.steps.length > 0 && loop.steps.every((s) => s.step.selector && !s.evidence.fragile), instruction: step.instruction },
      };
    }
    reasons.push(`ai: ${loop.reason}`);
  }

  if (typeof options.onGuided === "function") {
    tried.push("guided");
    const answer = await options.onGuided({ index, step, reason: reasons.join("; "), failedSelector: ctx.failedSelector, tried });
    if (answer && answer.selector) {
      const act = await surface.perform({ ...actionFor(step), selector: answer.selector });
      if (act.ok) {
        return { ok: true, layer: "guided", tried, patch: { index, layer: "guided", from: ctx.failedSelector, to: answer.selector, evidence: { byPerson: true }, promotable: true, instruction: step.instruction } };
      }
      reasons.push(`guided: ${act.reason}`);
    } else if (answer && answer.skip) {
      return { ok: false, skipped: true, reason: "skipped by the tester", tried };
    }
  }
  return { ok: false, reason: reasons.join("; "), tried };
}

/** Applies promotable patches to a copy of the steps (the caller decides whether to save them). */
function applyPatches(steps, patches) {
  const out = steps.map((s) => ({ ...s }));
  // Back to front so an AI patch that grows a step does not shift later indexes.
  [...patches].filter((p) => p.promotable).sort((a, b) => b.index - a.index).forEach((p) => {
    if (p.layer === "ai") out.splice(p.index, 1, ...p.replaceWith.map((s) => ({ ...s, resolvedBy: "ai" })));
    else out[p.index] = { ...out[p.index], selector: p.to, resolvedBy: p.layer };
  });
  return out;
}

module.exports = { climbLadder, applyPatches, LAYERS };
