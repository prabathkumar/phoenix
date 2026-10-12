/**
 * Semantic layer, written once against a Surface: plain-language instruction ->
 * one element. Optional vision add-on sends a screenshot with the element list
 * so similar-looking elements can be told apart; the list stays the source of
 * truth (the model answers with a ref from it, never a coordinate).
 *
 * Fail-safe contract (same as the mobile resolvers): never throws, never
 * guesses - an unconfident or invalid answer is `{resolved:false, reason}`.
 */
const { assertSurface } = require("./surface");

function snapshotToText(elements) {
  return elements.map((el) => {
    const bits = [];
    if (el.type) bits.push(`type: ${el.type}`);
    if (el.id) bits.push(`id: ${el.id}`);
    if (el.testid) bits.push(`testid: ${el.testid}`);
    if (el.placeholder) bits.push(`placeholder: ${el.placeholder}`);
    if (el.disabled) bits.push("disabled");
    if (el.inViewport === false) bits.push("off-screen");
    return `[${el.ref}] ${el.role}${el.name ? ` "${el.name}"` : ""}${bits.length ? ` (${bits.join(", ")})` : ""}`;
  }).join("\n");
}

/** What the model is told about why we are asking and what already went wrong. */
function contextLines(ctx = {}) {
  const out = [];
  if (ctx.failedSelector) {
    out.push(`The recorded locator ${JSON.stringify(ctx.failedSelector)} no longer finds the element${ctx.reason ? ` (${ctx.reason})` : ""}. The page has probably changed; find the element that now plays the same role.`);
  }
  const d = ctx.pageDiff;
  if (d && (d.appeared?.length || d.disappeared?.length)) {
    if (d.appeared?.length) out.push(`Text that appeared since the previous step: ${d.appeared.slice(0, 8).map((s) => JSON.stringify(s)).join(", ")}`);
    if (d.disappeared?.length) out.push(`Text that disappeared since the previous step: ${d.disappeared.slice(0, 8).map((s) => JSON.stringify(s)).join(", ")}`);
  }
  if (ctx.pastFailures?.length) {
    out.push("Earlier failures in this run (do not repeat them):");
    ctx.pastFailures.slice(-5).forEach((f) => out.push(`- step "${f.instruction}": ${f.reason}`));
  }
  return out;
}

function buildPrompt({ instruction, kind, elements, context, withImage }) {
  return [
    "You resolve one plain-language test instruction to ONE element on a page.",
    'Each candidate is: [ref] role "name" (details).',
    kind === "type" ? "This is a TEXT-ENTRY action: only choose an editable text field, never a link, button or label." : undefined,
    kind === "select" ? "This is a DROPDOWN action: only choose a select/combobox." : undefined,
    "",
    `Instruction: "${instruction}"`,
    ...contextLines(context),
    "",
    "Elements:",
    snapshotToText(elements),
    withImage ? "\nA screenshot of the page is attached. Use it to tell similar elements apart (position, icon, colour, grouping). Answer with a ref from the list." : undefined,
    "",
    "A wrong guess is far worse than declining: a bad click can submit or delete something. Choose only an element that clearly matches. If unsure, decline.",
    'Respond with ONLY JSON: {"ref": <number>} or {"ref": null, "reason": "<brief, specific>"}.',
  ].filter((l) => l !== undefined).join("\n");
}

/**
 * @param {Object} surface
 * @param {string} instruction
 * @param {{kind?:"tap"|"type"|"select", exclude?:number[], vision?:boolean, context?:Object,
 *          callModel?:Function, elements?:Object[]}} [opts]
 * @returns {Promise<{resolved:boolean, ref?:number, element?:Object, reason?:string, usedVision?:boolean, elements?:Object[]}>}
 */
async function resolveByInstruction(surface, instruction, opts = {}) {
  assertSurface(surface);
  const callModel = opts.callModel || require("../../generation/llm").callOllamaJson;
  const kind = opts.kind || "tap";
  const exclude = new Set(opts.exclude || []);
  try {
    const all = opts.elements || (await surface.snapshot());
    const elements = all.filter((e) => !exclude.has(e.ref));
    if (!elements.length) return { resolved: false, reason: "no interactive elements to choose from", elements: all };

    let usedVision = false;
    let result;
    if (opts.vision) {
      try {
        const shot = await surface.screenshot();
        result = await callModel(buildPrompt({ instruction, kind, elements, context: opts.context, withImage: true }), { images: [shot] });
        usedVision = true;
      } catch { result = undefined; /* model has no vision: fall back to text only */ }
    }
    if (result === undefined) result = await callModel(buildPrompt({ instruction, kind, elements, context: opts.context, withImage: false }));

    if (!result || (result.ref !== null && !Number.isInteger(result.ref))) throw new Error("model response missing a valid 'ref'");
    if (result.ref === null) {
      const raw = typeof result.reason === "string" ? result.reason.trim() : "";
      return { resolved: false, reason: raw && raw !== "..." && !/^<.*>$/.test(raw) ? raw : "model did not find a confident match", usedVision, elements: all };
    }
    const element = elements.find((e) => e.ref === result.ref);
    if (!element) return { resolved: false, reason: `model chose ref ${result.ref}, which is not an offered element`, usedVision, elements: all };
    if (element.disabled) return { resolved: false, reason: `"${element.name}" is disabled`, usedVision, elements: all };
    if (kind === "type" && !element.editable) return { resolved: false, reason: `"${element.name}" is not an editable field`, usedVision, elements: all };
    if (kind === "select" && element.tag !== "select") return { resolved: false, reason: `"${element.name}" is not a dropdown`, usedVision, elements: all };
    return { resolved: true, ref: element.ref, element, usedVision, elements: all };
  } catch (err) {
    return { resolved: false, reason: `resolution failed: ${err.message}` };
  }
}

module.exports = { resolveByInstruction, snapshotToText, buildPrompt };
