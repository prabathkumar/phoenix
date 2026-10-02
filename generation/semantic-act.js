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
const { getPastFailures, getDeadSelectors, getExpectFailedSelectors } = require("./execution-log");

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
 * @param {number[]} [options.excludedRefs] - refs (from a PRIOR call to
 *   this same function on the SAME pageSourceXml -- a ref is only
 *   stable within one snapshot) to remove from the candidate list
 *   entirely before the model ever sees them. This is the framework-
 *   level self-heal hook: engine/semantic-act-executor.js calls back in
 *   here with the just-tried element excluded when a tap produced "No
 *   visible change." -- a concrete, already-observed signal that the
 *   first pick was a dead end, not a guess that it might be. Without
 *   this, a resolver with no history has no way to avoid repeating the
 *   exact same wrong-but-confident pick it just made; this closes that
 *   loop live, during the run, with no human needed to notice from a
 *   log afterwards. Optional and defaults to excluding nothing, so
 *   existing callers are unaffected.
 *
 * ACROSS runs (not just within one), this function also automatically
 * reads generation/execution-log.js's getPastFailures(instruction) --
 * no option needed, always on -- and includes a short "this failed
 * before, here's why" note in the prompt when there's history for this
 * exact instruction. This is the read half of the automatic logging
 * engine/semantic-act-executor.js writes on every call: a past failure
 * is surfaced to the model as a soft hint (never a hard exclusion --
 * the screen can genuinely change between runs) with zero human step in
 * between. See docs/CONTINUOUS_TRAINING.md for the full picture of what
 * this is (instant, works on any hardware) and isn't (model weights
 * don't change; that's a separate, periodic, GPU-dependent process).
 * @returns {Promise<SemanticActionResult>}
 */
async function resolveSemanticAction(pageSourceXml, instruction, options = {}) {
  const snapshot = buildGroundedSnapshot(pageSourceXml);

  // Cross-run dead-tap exclusion (docs/CONTINUOUS_TRAINING.md §2(b)'s
  // flagged next increment): a resource-id/accessibility-id/text value
  // already PROVEN, on a prior run of this exact instruction, to be a
  // dead end (a tap that produced literally "No visible change.") is
  // removed from the candidate list here -- before the model ever sees
  // it -- exactly the same way engine/semantic-act-executor.js's
  // in-run self-heal removes the just-tried element via excludedRefs,
  // just persisted across runs instead of only within one. Matched by
  // VALUE (resource-id/accessibility-id/text), not by `ref` (refs are
  // only stable within one snapshot) -- see getDeadSelectors()'s doc
  // comment for why this is safe as a hard exclusion where
  // getPastFailures() below deliberately stays a soft hint: a dead tap
  // is a concrete fact about a specific control, not a judgment call
  // about whether an instruction was understood. Scoped to "tap" only,
  // matching the self-heal mechanism it extends. If the screen
  // genuinely changed such that this value now identifies a different,
  // real control, nothing here actively blocks it -- a stale dead
  // selector that happens to match a NEW element would wrongly exclude
  // it, but that's the same accepted tradeoff the live excludedRefs
  // mechanism already makes for "fewer wrong confident picks" over
  // "never wrongly exclude a coincidental value match."
  const deadSelectors = options.kind === "tap" ? getDeadSelectors(instruction) : [];
  const deadRefs = deadSelectors.length === 0
    ? new Set()
    : new Set(
        snapshot
          .filter((el) =>
            deadSelectors.some(
              (sel) =>
                (sel.strategy === "resource-id" && el.resourceId === sel.value) ||
                (sel.strategy === "accessibility-id" && el.accessibilityId === sel.value) ||
                (sel.strategy === "text" && el.label === sel.value)
            )
          )
          .map((el) => el.ref)
      );

  // Cross-run "wrong but functional click" exclusion (the parallel case
  // to deadRefs above, see getExpectFailedSelectors()'s doc comment): a
  // selector that already produced a REAL diff on a prior run of this
  // exact instruction, but whose declared `expect` still never held
  // even after the outcome-settle retry, is removed from the candidate
  // list the same way a dead (no-op) tap is -- it's a different failure
  // shape (something happened, just not the right thing) but just as
  // concrete and just as safe to hard-exclude, for the same reason
  // deadRefs is safe to: a proven fact about a specific control, not a
  // judgment call about how the instruction should be read.
  const expectFailedSelectors = options.kind === "tap" ? getExpectFailedSelectors(instruction) : [];
  const expectFailedRefs = expectFailedSelectors.length === 0
    ? new Set()
    : new Set(
        snapshot
          .filter((el) =>
            expectFailedSelectors.some(
              (sel) =>
                (sel.strategy === "resource-id" && el.resourceId === sel.value) ||
                (sel.strategy === "accessibility-id" && el.accessibilityId === sel.value) ||
                (sel.strategy === "text" && el.label === sel.value)
            )
          )
          .map((el) => el.ref)
      );

  const allElements = snapshot.filter(
    (el) =>
      !(options.excludedRefs && options.excludedRefs.includes(el.ref)) &&
      !deadRefs.has(el.ref) &&
      !expectFailedRefs.has(el.ref)
  );

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

  // Automatic feedback from past runs -- the read half of the logging
  // this layer now also writes on every call (execution-log.js). This
  // is what makes "learns from every execution" genuinely automatic
  // rather than a diary nobody reads back: no human has to notice a
  // repeated failure and hand-author a fix for it to at least be
  // surfaced to the model as context on the next attempt. Deliberately
  // a soft hint in the prompt, never a hard exclusion -- see
  // getPastFailures()'s own doc comment for why.
  const pastFailures = getPastFailures(instruction);

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
      pastFailures.length > 0
        ? [
            `Note: on ${pastFailures.length} past run(s), this exact instruction failed:`,
            ...pastFailures.map((f, i) => `  ${i + 1}. ${f.reason || f.diffSummary || "failed, no reason recorded"}`),
            "The screen may have changed since then, so don't rule out a candidate just because it resembles one of these -- but if you're about to repeat the same mistake for the same reason, prefer declining over guessing again.",
            "",
          ].join("\n")
        : undefined,
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
