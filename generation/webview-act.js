/**
 * Resolves a plain-language instruction against a WebView DOM snapshot
 * -- the WebView counterpart to semantic-act.js's resolveSemanticAction(),
 * same model (local Ollama), same fail-safe contract (never throws,
 * never guesses: an unconfident match returns `{resolved: false,
 * reason}` rather than picking anything), same "a wrong guess is worse
 * than declining" reasoning from docs/PHOENIX_SPEC.md §2. Kept as a
 * separate function rather than branching inside resolveSemanticAction()
 * itself so neither resolver's prompt/candidate shape has to compromise
 * for the other's.
 */

const { callOllamaJson } = require("./llm");
const { buildWebviewSnapshot, webviewSnapshotToText, findByRef, buildCssSelector } = require("./webview-snapshot");

/**
 * @param {Array<Object>} rawDomElements - whatever
 *   webview-snapshot.js's SERIALIZE_DOM_SCRIPT returned from the live page.
 * @param {string} instruction
 * @param {Object} [options]
 * @param {"tap"|"type"} [options.kind]
 * @returns {Promise<{resolved: boolean, element?: Object, selector?: {strategy: "css", value: string}, reason?: string}>}
 */
async function resolveWebviewAction(rawDomElements, instruction, options = {}) {
  const elements = buildWebviewSnapshot(rawDomElements);

  if (elements.length === 0) {
    return { resolved: false, reason: "WebView DOM snapshot has no interactive elements to act on" };
  }

  try {
    const prompt = [
      "You are resolving a natural-language mobile test instruction against",
      "a snapshot of the interactive elements currently visible in a WebView",
      "(a browser-rendered page inside a mobile app). Each line is one",
      'candidate element: [ref] tag/role "text" (identifiers).',
      options.kind === "type"
        ? 'This instruction is a TEXT-ENTRY action: only match an actual editable input (an <input>, <textarea>, or role="textbox"). Never match a plain link, button, or label.'
        : undefined,
      "",
      `Instruction: "${instruction}"`,
      "",
      "Snapshot:",
      webviewSnapshotToText(elements),
      "",
      "A wrong guess is far more costly than correctly declining: a bad click",
      "or submit can navigate away or submit something, and nothing",
      "downstream can undo it. Match only an element whose own text, label,",
      "or purpose clearly and specifically corresponds to the instruction. If",
      "you are not highly confident, you MUST decline.",
      "",
      "Respond with ONLY a JSON object. If exactly one element is a confident",
      'match, respond {"ref": <number>}. If no element is a confident match,',
      'respond {"ref": null, "reason": "<your own brief, specific',
      'explanation>"} instead of guessing.',
    ].filter((line) => line !== undefined).join("\n");

    const result = await callOllamaJson(prompt);

    if (!result || (result.ref !== null && !Number.isInteger(result.ref))) {
      throw new Error("Ollama response missing expected 'ref' field");
    }

    if (result.ref === null) {
      const rawReason = typeof result.reason === "string" ? result.reason.trim() : "";
      const isPlaceholderEcho = rawReason === "..." || /^<.*>$/.test(rawReason);
      const reason = rawReason && !isPlaceholderEcho ? rawReason : "model did not find a confident match";
      return { resolved: false, reason };
    }

    const element = findByRef(elements, result.ref);
    if (!element) {
      return { resolved: false, reason: `model referenced ref ${result.ref}, which is not in this snapshot` };
    }

    const cssSelector = buildCssSelector(element);
    if (!cssSelector) {
      // Real, honest limit (see buildCssSelector's own doc comment): this
      // element has no id/name/aria-label/placeholder to address it by.
      // Declining here, not falling back to a brittle guessed path.
      return { resolved: false, reason: `matched element has no stable id/name/aria-label/placeholder to build a selector from (ref ${result.ref})` };
    }

    return { resolved: true, element, selector: { strategy: "css", value: cssSelector } };
  } catch (err) {
    console.warn("[generation/webview-act] resolveWebviewAction failed, returning unresolved:", err.message);
    return { resolved: false, reason: `resolution failed: ${err.message}` };
  }
}

module.exports = { resolveWebviewAction };
