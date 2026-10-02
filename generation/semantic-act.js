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
 * @param {Object} [options]
 * @param {"tap"|"type"} [options.kind] - when "tap" and this element is
 *   explicitly non-clickable but semantic-snapshot.js found a clickable
 *   ancestor (see clickableAncestorXPath), redirect the tap there instead
 *   of an element a real click on it would do nothing to. Found for
 *   real: a Compose tab whose visible label was a non-clickable TextView
 *   -- tapping it "succeeded" (no WebDriver error) but changed nothing.
 * @returns {{strategy: string, value: string}|undefined}
 */
function toSelector(element, options = {}) {
  if (options.kind === "tap" && element.clickable === false && element.clickableAncestorXPath) {
    return { strategy: "xpath", value: element.clickableAncestorXPath };
  }
  // Found for real: two EditTexts on the same screen (Yes Number and
  // Password) sharing one resource-id, distinguished only by a sibling
  // label TextView -- a resource-id selector built from either one is
  // genuinely ambiguous (WebDriver's `$` just returns whichever matches
  // first), so semantic-snapshot.js flags this case and also computes
  // an xpath for it; prefer that over the ambiguous resource-id.
  if (element.resourceId && !element.ambiguousResourceId) return { strategy: "resource-id", value: element.resourceId };
  // Found for real on a live BrowserStack iOS run (login-script mode,
  // first real-hardware run): an iOS secure field's accessibility id
  // can be just as live as its label -- this app's password field
  // reports accessibility id "PASSWORD" while empty (apparently derived
  // from its placeholder), but that name disappears from the
  // accessibility tree entirely once real text is typed into it (iOS's
  // own privacy behavior for secure fields). A `setValue()` call
  // against "~PASSWORD" can succeed once, then internally re-resolve
  // the same selector a moment later (to verify/retry) and fail with
  // "element wasn't found" -- the exact live-selector failure bug 13
  // already fixed for `label`, just surfacing through `accessibilityId`
  // instead. Only skip it when there's a classChain to fall back to
  // (i.e. this is one of bug 13's iOS secure fields, see
  // needsIosPositionalLocator in semantic-snapshot.js) -- Android's
  // secure fields have no classChain and their accessibility id IS
  // stable (bug 8 was only ever about Android's live masked *text*),
  // so this must not touch the existing, already-correct Android path.
  // Found for real on a live BrowserStack iOS run: a home screen's
  // "LOGIN" button (opens the login form) and the form's own submit
  // button can share the exact same accessibility id -- WebDriver's
  // `$("~LOGIN")` then just returns whichever matches first, which a
  // real run's log confirmed was the SAME element both times, so a
  // "submit" tap silently re-clicked the original, by-then-hidden
  // button instead of the real one. semantic-snapshot.js flags this as
  // `ambiguousAccessibilityId` and computes a classChain predicate
  // (name + visibility together) to disambiguate -- prefer that the
  // same way the two guards above already prefer classChain/xpath over
  // a plain accessibility-id for their own ambiguous cases.
  if (element.accessibilityId && !element.ambiguousAccessibilityId && !(element.secure && element.classChain)) {
    return { strategy: "accessibility-id", value: element.accessibilityId };
  }
  // Found for real on a live BrowserStack run: a password field's
  // `label` is populated from its own masked display text (e.g.
  // "•••••••") once something has been typed into it -- that text
  // changes (different dot count, briefly empty) every time the field
  // is cleared and retyped, so a "text" selector built from it goes
  // stale the moment it's used, and WebDriver can never find that exact
  // element again. Skip the live-text strategy entirely for a secure
  // field (semantic-snapshot.js's `secure` flag) and fall through to
  // the stable xpath/resource-id below instead.
  // Found for real on a live BrowserStack iOS run (ios15): the
  // ambiguous-accessibility-id guard above correctly skips
  // `accessibility-id` for a duplicate-named element like the LOGIN
  // button, but the element's `label` is exactly as duplicated as its
  // accessibility id (both come from the same "LOGIN" name) -- this
  // block had no ambiguity check of its own, so it caught the skip and
  // built a `label == "LOGIN" OR value == "LOGIN"` predicate that was
  // just as ambiguous, resolving to the same first-matching (hidden)
  // element every time. Must also fall through to classChain here.
  if (element.label && !element.secure && !element.ambiguousAccessibilityId) return { strategy: "text", value: element.label };
  // A blank input field, or one with an ambiguous resource-id (see
  // semantic-snapshot.js's INPUT_ROLE_RE/ambiguousResourceId), has none
  // of the above -- a positional locator is the last-resort for it,
  // same tier the guided path already uses. Found for real on a live
  // BrowserStack iOS run: a structural xpath built the same way as
  // Android's was reproducible across 20+ seconds of polling an
  // unchanged screen, yet XCUITestDriver's native xpath finder still
  // returned "no such element" for it every time -- not a staleness
  // bug, the native engine just doesn't reliably resolve that shape of
  // path. `classChain` (set only for iOS elements, see
  // semantic-snapshot.js's buildIosClassChain) uses WebDriverAgent's
  // own natively-supported "class chain" locator instead, which has no
  // ancestor path to go stale in the first place -- prefer it over
  // `xpath` whenever both could apply.
  if (element.classChain) return { strategy: "class-chain", value: element.classChain };
  if (element.xpath) return { strategy: "xpath", value: element.xpath };
  if (element.resourceId) return { strategy: "resource-id", value: element.resourceId };
  return undefined;
}

/**
 * Resolves a natural-language instruction against a captured screen.
 *
 * @param {string} pageSourceXml - same input buildGroundedSnapshot() and
 *   pipeline.js's extractLabels() take.
 * @param {string} instruction - e.g. "tap the Login button".
 * @param {Object} [options]
 * @param {string} [options.screenshotBase64] - when given, resolves in
 *   "fused" mode (docs/PHOENIX_SPEC.md §6): the prompt includes bounds
 *   per element and the screenshot is sent alongside via Ollama's
 *   `images` field (generation/llm.js), for a multimodal-capable model
 *   to cross-check the text snapshot against what's actually visible.
 *   Omit for the existing text-only mode, unaffected either way.
 * @param {"tap"|"type"} [options.kind] - the action this resolution is
 *   for. Found necessary from a real device run: without this, the
 *   model had no signal that a "type into X" instruction needs an
 *   actual editable input, and would confidently match the nearby
 *   label text instead (which then fails at execution time -- text
 *   isn't editable). Optional and defaults to no hint at all, so
 *   existing callers that don't pass it are unaffected.
 * @returns {Promise<SemanticActionResult>}
 */
async function resolveSemanticAction(pageSourceXml, instruction, options = {}) {
  const allElements = buildGroundedSnapshot(pageSourceXml);

  if (allElements.length === 0) {
    return { resolved: false, reason: "grounded snapshot has no labeled/identified elements to act on" };
  }

  // Found for real on a live BrowserStack run: a Compose tab control's
  // container (a ComposeView carrying its own resource-id, itself
  // non-clickable, with no clickable ancestor either -- its clickable
  // tab Views sit BELOW it in the tree, which clickableAncestorXPath
  // doesn't reach) sat in the same candidate list as the correctly
  // redirectable "PASSWORD" label and the model picked the container
  // instead. A real click on it is a guaranteed no-op (confirmed: the
  // page source was byte-identical before and after), which silently
  // wasted a step and, two steps later, made the loop try to type the
  // password into the still-visible Yes Number field a second time.
  // Rather than hope the model always avoids a dead-end candidate,
  // remove any element that a "tap" is certain to do nothing to --
  // explicitly non-clickable (clickable === false) with no
  // clickableAncestorXPath to redirect to -- before it's ever offered.
  // clickable === undefined (iOS, or Android simply didn't set the
  // attribute) is NOT filtered: that means "unknown", not "known no-op".
  const elements = options.kind === "tap"
    ? allElements.filter((el) => !(el.clickable === false && !el.clickableAncestorXPath))
    : allElements;

  if (elements.length === 0) {
    return { resolved: false, reason: "grounded snapshot has elements, but every one is a known non-clickable dead end for a tap" };
  }

  const fused = Boolean(options.screenshotBase64);

  try {
    const prompt = [
      "You are resolving a natural-language mobile test instruction against",
      "a snapshot of the elements currently visible on screen. Each line is",
      "one candidate element: [ref] role \"label\" (identifiers). An entry",
      'marked (empty input near: "...") is a blank, editable text field with',
      "no label of its own -- the quoted text is just the nearby caption, not",
      "this element's own value.",
      options.kind === "type"
        ? "This instruction is a TEXT-ENTRY action: only match an actual editable input field (an entry marked \"empty input near\", or an EditText/TextField-like role). Never match a plain label or button, even if its text matches the instruction closely -- it cannot be typed into."
        : undefined,
      fused
        ? "A screenshot of the current screen is attached -- use it alongside the text below to confirm your match, especially when text alone is ambiguous."
        : undefined,
      "",
      `Instruction: "${instruction}"`,
      "",
      "Snapshot:",
      snapshotToText(elements, { includeBounds: fused }),
      "",
      "A wrong guess is far more costly than correctly declining: a bad tap",
      "can navigate away, open an unrelated screen, or submit something, and",
      "nothing downstream can undo it. Match only an element whose own label,",
      "role, or purpose clearly and specifically corresponds to the",
      "instruction -- never one that merely shares a category (any dialog's",
      "dismiss icon is not \"the CLOSE button\" the instruction means; a menu's",
      "OPEN icon is not its CLOSE icon; a screen's own back/navigation arrow",
      "is not an application dialog's dismiss button) or a loose word overlap",
      "(\"More\" appearing in both an instruction and a label is not, by",
      "itself, a match). If you are not highly confident, you MUST decline.",
      "",
      "Respond with ONLY a JSON object. If exactly one element is a confident",
      'match for the instruction, respond {"ref": <number>}. If no element',
      "is a confident match -- the instruction is ambiguous, refers to",
      "nothing on screen, or you're not sure -- respond",
      '{"ref": null, "reason": "<your own brief, specific explanation of',
      'why nothing matches>"} instead of guessing. Write a real sentence',
      "for \"reason\" -- never literally copy the words \"<your own brief...\"",
      "from this instruction itself.",
    ].filter((line) => line !== undefined).join("\n");

    const result = await callOllamaJson(prompt, fused ? { images: [options.screenshotBase64] } : undefined);

    if (!result || (result.ref !== null && !Number.isInteger(result.ref))) {
      throw new Error("Ollama response missing expected 'ref' field");
    }

    if (result.ref === null) {
      // Real bug found on real hardware (docs/STATUS.md: addons.json,
      // addons-run-android-6.log): the prompt's own JSON-shape example
      // for an unresolved match showed a literal placeholder in the
      // "reason" field, and the model sometimes echoed that placeholder
      // back verbatim instead of writing an actual explanation --
      // "prompt-template echoing", the same failure class already seen
      // once before in the autonomous loop (spec's bug list). A bare
      // echo is non-empty and passes a plain truthiness/trim() check,
      // so it would otherwise surface as a useless reason like "...".
      // Reworded the prompt to make the placeholder harder to copy
      // verbatim, and treat a known-echo value the same as "no reason
      // given" here as a second line of defense.
      const rawReason = typeof result.reason === "string" ? result.reason.trim() : "";
      const isPlaceholderEcho = rawReason === "..." || /^<.*>$/.test(rawReason);
      const reason = rawReason && !isPlaceholderEcho
        ? rawReason
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

    const selector = toSelector(element, { kind: options.kind });
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
