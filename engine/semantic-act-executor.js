/**
 * Wires generation/semantic-act.js's resolution up to a live Appium
 * session — the piece explicitly called out as not-yet-built in
 * docs/TESTOPS_MOBILE_SPEC.md §6/README's Act 2 section: "actually issuing the
 * resulting tap/setValue against a live Appium session." Everything
 * upstream of this file (buildGroundedSnapshot, resolveSemanticAction,
 * diffSnapshots) only reads an already-captured pageSourceXml string;
 * this is the first module that takes a live `driver` and does
 * something to the device.
 *
 * Scope, deliberately narrow: `executeSemanticAction()` captures the
 * current screen, resolves the instruction against it, performs
 * exactly one WebDriver action (tap or type) via the SAME selector
 * strings pipeline.js's buildSelector() already produces for the guided
 * path (resource-id / accessibility-id / text), and reports what
 * changed. It does not decide *what* to do next, retry, or loop — that
 * decision logic is Phase 3's autonomous loop (spec §6), still
 * unbuilt. This module only answers "given one instruction, can I
 * carry it out on the real device, and what happened."
 *
 * Fail-safe by the same contract as the rest of this layer
 * (generation/llm.js, generation/semantic-act.js): every failure mode
 * — no confident match, element vanished before the action could run,
 * an unsupported action kind, any WebDriver error — is reported as
 * `{success: false, reason}` rather than thrown. A caller (eventually,
 * a Phase 3 loop) can treat "unsuccessful" uniformly as "stop and hand
 * back to a human," without a try/catch of its own.
 */

const { resolveSemanticAction } = require("../generation/semantic-act");
const { diffSnapshots, diffToText } = require("../generation/semantic-diff");
const { inferSemanticAssertions } = require("../generation/semantic-assertions");
const { buildSelector } = require("../generation/pipeline");
const { logExecution, buildExecutionRecord } = require("../generation/execution-log");
const { verifyExpectedOutcome } = require("../generation/outcome-verification");
const { detectWebviewContext } = require("./webview-context");
const { resolveWebviewAction } = require("../generation/webview-act");
const { SERIALIZE_DOM_SCRIPT } = require("../generation/webview-snapshot");

const SUPPORTED_KINDS = new Set(["tap", "type", "scroll", "tapIfExists"]);

// Found for real on a live BrowserStack run (addons-run-android: the
// Add-ons-tap step, test-cases/addons.json): `actAndDiff()` clicked a
// real element and read the page source back with zero delay between
// the two calls. The screen was still showing a loading spinner at
// that instant -- the popup the step's own `expect: {appeared:
// ["Add-On"]}` declares hadn't rendered yet -- so outcome verification
// correctly reported a failure, but for the wrong underlying reason: a
// timing race, not a wrong click. Same root cause already fixed once
// for the autonomous loop (see engine/semantic-loop.js's
// DEFAULT_TAP_SETTLE_DELAY_MS and its comment) but never applied here,
// where every test-case tap/type's diff (and now, every `expect`
// check) is actually computed. Scoped to "tap" only, same reasoning as
// the loop's version: typing a character doesn't trigger a full-screen
// transition the way navigating to a new screen does.
const DEFAULT_ACT_SETTLE_DELAY_MS = 800;

// The fixed DEFAULT_ACT_SETTLE_DELAY_MS above closed the *animation*
// version of this race (a tap-triggered transition still rendering).
// Confirmed live, after that fix shipped, that it does NOT close the
// *network* version: a real BrowserStack run of the SAME Add-ons-tap
// step tapped the correct, cached selector (my.yes.yes4g:id/
// buyAddonLayout), got a real success from WebDriver, waited the full
// 800ms settle delay, and the post-tap screen was still just a bare
// ProgressBar -- the Add-On content hadn't come back from the network
// yet. 800ms is tuned for a UI transition, not a data fetch, and
// guessing a single bigger fixed number has the same problem
// DEFAULT_ACT_SETTLE_DELAY_MS's own comment already rejected: it either
// wastes time on every fast step or still isn't enough for a slow one.
// Scoped specifically to steps that declare an `expect` (generation/
// outcome-verification.js) -- a step with no declared expectation gets
// no extra wait, exactly as before. When `expect` doesn't hold right
// after the settle delay, keep polling getPageSource()/re-diffing (the
// same generic signal already used everywhere else in this file) until
// it does or this timeout elapses, instead of failing a step that was
// actually still loading. If it never holds, the ORIGINAL diff -- not a
// fabricated "it passed" -- is what test-case-runner.js's own
// verifyExpectedOutcome() call ultimately judges, so a genuinely wrong
// click still fails exactly as it does today.
const DEFAULT_OUTCOME_SETTLE_TIMEOUT_MS = 8000;
const DEFAULT_OUTCOME_SETTLE_POLL_MS = 1000;

/**
 * @typedef {Object} SemanticActionExecutionResult
 * @property {boolean} success
 * @property {string} [reason] - present when !success.
 * @property {{strategy: string, value: string}} [selector] - present on success.
 * @property {import('../generation/semantic-diff').SemanticDiff} [diff] - present on success.
 * @property {string} [diffSummary] - present on success; diffToText(diff).
 * @property {import('../generation/semantic-assertions').SemanticAssertion[]} [assertions] -
 *   present when `diff` is (i.e. success and the post-action screen
 *   read worked); inferSemanticAssertions(diff) -- see that module.
 */

/**
 * @param {import('webdriverio').Browser} driver - an already-started
 *   session, e.g. from engine/session-manager.js's `active.driver`.
 * @param {string} instruction - e.g. "tap the Login button".
 * @param {Object} [options]
 * @param {"tap"|"type"} [options.kind] - defaults to "tap". "type"
 *   requires options.text.
 * @param {string} [options.text] - text to send when kind is "type".
 * @param {"android"|"ios"} [options.platform] - defaults to "android",
 *   same default chain session-manager.js uses -- selects selector
 *   syntax via pipeline.js's buildSelector().
 * @param {boolean} [options.useVisualGrounding] - when true, also
 *   captures a screenshot (`driver.takeScreenshot()`) and passes it to
 *   `resolveSemanticAction()` for fused (text + image) resolution --
 *   docs/TESTOPS_MOBILE_SPEC.md §6's "merge accessibility tree + screenshot"
 *   bullet. Off by default: text-only resolution is cheaper, faster,
 *   and is what's been exercised so far; this is opt-in for whenever
 *   text alone proves ambiguous enough to be worth the extra cost. A
 *   screenshot failure here falls back to text-only rather than
 *   failing the whole action -- the point of the screenshot is to help
 *   resolution, not to be a new way for it to fail.
 * @param {{strategy: string, value: string}} [options.exactSelector] -
 *   REQUIRED when kind is "tapIfExists", ignored otherwise. A literal,
 *   hand-authored (or previously-learned) selector for an element that
 *   may or may not be on screen -- a conditional recovery/dismiss step
 *   (a dialog that only sometimes appears, an overlay's close icon).
 *   Unlike every other kind, this NEVER calls resolveSemanticAction and
 *   NEVER falls back to semantic guessing: the element either exists
 *   (tapped) or it doesn't (silently skipped, still `success: true`).
 *   This exists because asking an LLM resolver to judge "is this
 *   specific thing present" for a conditional step proved, on real
 *   hardware, impossible to make reliable through prompt wording alone
 *   -- docs/STATUS.md bugs #6/#7/#9/#11/#12/"Thirteenth" are all the
 *   SAME two elements (a login form's own Back Arrow icon, and the
 *   already-open "More Icon") getting mistaken for an unrelated
 *   dialog's dismiss button, across three separate rounds of
 *   instruction rewording and prompt hardening. A step whose job is
 *   "decide whether to act" is the wrong kind of step to hand to a
 *   component that can be confidently wrong; `tapIfExists` removes the
 *   judgment call entirely by replacing it with a plain WebDriver
 *   existence check against a selector no LLM ever chose at runtime.
 * @param {{strategy: string, value: string}} [options.cachedSelector] -
 *   a selector already proven to resolve this exact instruction on a
 *   previous run (see test-case-runner.js's selector cache). When
 *   given, this is tried FIRST, directly, with no LLM call at all --
 *   the deterministic "replay" path every mature test tool uses once a
 *   locator is known, instead of re-resolving from scratch and risking
 *   a fresh wrong guess on every single run (the actual root cause
 *   behind docs/STATUS.md's bugs #6/#7/#11/#12 -- the same step
 *   independently re-rolling the dice on every run, including ones
 *   where it had already resolved correctly before). Only if the cache
 *   is missing, stale, or fails to act is full semantic resolution
 *   attempted as a fallback -- "self-healing," not "guess every time."
 *   On a result, check `usedCache` / `healedFromCache` below to know
 *   which path actually ran.
 * @returns {Promise<SemanticActionExecutionResult & {usedCache?: boolean, healedFromCache?: boolean}>}
 */
async function executeSemanticAction(driver, instruction, options = {}) {
  const result = await executeSemanticActionInner(driver, instruction, options);
  // Automatic execution logging -- explicit requirement: this has to
  // be a framework capability wired into the semantic layer itself,
  // not a manual step, and not something that only runs for one log
  // source. Every call through this function, whatever path it takes
  // (fresh resolution, cache hit, self-heal, tapIfExists skip, a
  // reported failure), is captured as one structured record with zero
  // caller involvement. See generation/execution-log.js for the
  // credential-safety contract and what this is/isn't a substitute for.
  logExecution(buildExecutionRecord(instruction, options, result));
  return result;
}

async function executeSemanticActionInner(driver, instruction, options = {}) {
  const kind = options.kind || "tap";
  const platform = options.platform === "ios" ? "ios" : "android";

  if (!SUPPORTED_KINDS.has(kind)) {
    return { success: false, reason: `unsupported action kind "${kind}" (expected "tap", "type", "scroll", or "tapIfExists")` };
  }
  if (kind === "type" && typeof options.text !== "string") {
    return { success: false, reason: 'kind "type" requires options.text' };
  }

  let pageSourceBefore;
  try {
    pageSourceBefore = await driver.getPageSource();
  } catch (err) {
    return { success: false, reason: `couldn't read the current screen: ${err.message}` };
  }

  // "scroll" has no instruction to resolve against the screen -- there
  // is no single target element, just "move the viewport" -- so it
  // skips resolveSemanticAction/buildSelector entirely and goes
  // straight to a native scroll gesture. Added for a real gap found on
  // real hardware (docs/STATUS.md: addons.json's Logout button sits
  // below the fold in a ScrollView on the Profile screen, and nothing
  // in this layer could move the viewport to reach it).
  if (kind === "scroll") {
    return performScroll(driver, pageSourceBefore, options, platform);
  }

  // "tapIfExists": a conditional recovery step authored with a known,
  // literal selector -- NEVER resolved by the LLM, not even as a
  // fallback. See the option's doc comment above for why: this is the
  // one kind that must be incapable of guessing, because guessing on a
  // "is this maybe-present thing here" step is exactly what kept
  // regressing (docs/STATUS.md). A missing/malformed exactSelector is a
  // test-case authoring error, not a runtime "not found" -- reported as
  // a failure rather than silently skipped, so it's caught immediately
  // rather than masquerading as "the dialog just wasn't there."
  if (kind === "tapIfExists") {
    if (!options.exactSelector || !options.exactSelector.strategy || !options.exactSelector.value) {
      return { success: false, reason: 'kind "tapIfExists" requires options.exactSelector ({strategy, value})' };
    }
    const exactSelectorString = buildSelector(options.exactSelector, platform);
    if (!exactSelectorString) {
      return { success: false, reason: `couldn't build a selector for ${JSON.stringify(options.exactSelector)}` };
    }
    let element;
    let exists = false;
    try {
      element = await driver.$(exactSelectorString);
      exists = await element.isExisting();
    } catch (err) {
      return { success: false, reason: `couldn't check for (${exactSelectorString}): ${err.message}` };
    }
    if (!exists) {
      // Not present -- exactly the expected, common case for a
      // conditional step. Never a failure, never a fallback resolution.
      return { success: true, skipped: true, diffSummary: `skipped: (${exactSelectorString}) not present` };
    }
    if (typeof options.beforeAct === "function") {
      const vetoReason = options.beforeAct({ selector: options.exactSelector, selectorString: exactSelectorString, kind: "tap", text: undefined });
      if (vetoReason) {
        return { success: false, reason: vetoReason };
      }
    }
    const outcome = await actAndDiff(driver, exactSelectorString, "tap", undefined, pageSourceBefore, { settleMs: options.actSettleMs, sleep: options.sleep, expect: options.expect, outcomeSettleTimeoutMs: options.outcomeSettleTimeoutMs, outcomeSettlePollMs: options.outcomeSettlePollMs });
    if (!outcome.success) {
      return outcome;
    }
    return { ...outcome, selector: options.exactSelector };
  }

  // Deterministic replay path: a selector already proven correct for
  // this exact step on an earlier run. No LLM call, no fresh dice roll
  // -- just act on the known-good locator. If it's missing (element
  // genuinely not there this run) or the action itself fails (stale,
  // UI changed), fall through to full semantic resolution below rather
  // than failing outright -- this is the "heal" half of self-healing.
  if (options.cachedSelector && options.cachedSelector.strategy && options.cachedSelector.value) {
    const cachedSelectorString = buildSelector(options.cachedSelector, platform);
    if (cachedSelectorString) {
      if (typeof options.beforeAct === "function") {
        const vetoReason = options.beforeAct({ selector: options.cachedSelector, selectorString: cachedSelectorString, kind, text: options.text });
        if (vetoReason) {
          return { success: false, reason: vetoReason };
        }
      }
      const cachedOutcome = await actAndDiff(driver, cachedSelectorString, kind, options.text, pageSourceBefore, { settleMs: options.actSettleMs, sleep: options.sleep, expect: options.expect, outcomeSettleTimeoutMs: options.outcomeSettleTimeoutMs, outcomeSettlePollMs: options.outcomeSettlePollMs });
      if (cachedOutcome.success) {
        return { ...cachedOutcome, selector: options.cachedSelector, usedCache: true };
      }
      // Cache miss -- the cached locator didn't resolve or act this
      // time. Fall through to a full, fresh semantic resolution.
    }
  }

  // WebView/browser priority (engine/webview-context.js,
  // generation/webview-act.js): explicit requirement -- "if there are
  // web browsers in the app let it be prioritized". A real DOM gives
  // far richer, more stable selectors than a native accessibility tree
  // offers of the same rendered content, so when a WebView context is
  // genuinely present, try resolving there BEFORE falling back to
  // native resolution below. Fully automatic (no per-step opt-in flag
  // needed) but entirely safe for an all-native app: detectWebviewContext
  // returns null whenever there's no WEBVIEW_* context to find (every
  // real app this has run against so far, including addons.json/
  // addons.ios.json), so this block is a confirmed no-op for them and
  // changes nothing about their behavior. tryWebviewAction() returns
  // null (not a result) for "no usable webview answer here" -- couldn't
  // switch, couldn't read the DOM, or the model declined -- which falls
  // through to the existing native path exactly as if this block didn't
  // run at all; it only returns a real result on an actual webview
  // success or a genuine webview-side action failure (vetoed, element
  // vanished, click/setValue threw).
  if (!options.disableWebview) {
    const webviewContext = await detectWebviewContext(driver);
    if (webviewContext) {
      const webviewOutcome = await tryWebviewAction(driver, webviewContext, instruction, options, kind);
      if (webviewOutcome) {
        return webviewOutcome;
      }
    }
  }

  let screenshotBase64;
  if (options.useVisualGrounding) {
    try {
      screenshotBase64 = await driver.takeScreenshot();
    } catch (err) {
      // Fall back to text-only resolution -- see the option's doc
      // comment above for why this doesn't fail the action outright.
      console.warn("[engine/semantic-act-executor] couldn't capture a screenshot for fused resolution, falling back to text-only:", err.message);
    }
  }

  let resolution = await resolveSemanticAction(pageSourceBefore, instruction, { screenshotBase64, kind });
  if (!resolution.resolved) {
    // One bounded retry on an outright decline (not a WebDriver error --
    // resolveSemanticAction never throws, see its own fail-safe
    // contract), found for real: docs/STATUS.md bug #7 (addons.ios.json
    // run 11) showed a decline can come from the screen genuinely still
    // being mid-transition/loading a moment before, which a single fresh
    // read can resolve on its own. Re-reads the LIVE screen (not just
    // reusing the stale pageSourceBefore) so a real timing race actually
    // gets a chance to clear, and feeds the model its own prior decline
    // reason back as context so the second look is informed, not a
    // blind re-roll of the same dice. Exactly one retry, win or lose --
    // "try twice and then fail", never an unbounded loop -- and the
    // FINAL outcome (second decline's reason, or a resolved+acted
    // result) is what gets returned and logged; nothing here invents a
    // success or hides that a retry happened.
    const firstDeclineReason = resolution.reason;
    let retryPageSource = pageSourceBefore;
    try {
      retryPageSource = await driver.getPageSource();
    } catch (err) {
      // Couldn't re-read the screen -- retry against the already-
      // captured snapshot rather than failing the whole retry attempt
      // over a transient read error.
    }
    const retryResolution = await resolveSemanticAction(retryPageSource, instruction, {
      screenshotBase64,
      kind,
      priorDeclineReason: firstDeclineReason,
    });
    if (!retryResolution.resolved) {
      return { success: false, reason: retryResolution.reason, firstAttemptReason: firstDeclineReason, retried: true };
    }
    resolution = retryResolution;
    pageSourceBefore = retryPageSource;
  }

  const selectorString = buildSelector(resolution.selector, platform);
  if (!selectorString) {
    // Shouldn't happen -- resolveSemanticAction only ever returns
    // resource-id/accessibility-id/text strategies, all of which
    // buildSelector() handles -- but stay unresolved rather than
    // silently doing nothing.
    return { success: false, reason: `couldn't build a selector for ${JSON.stringify(resolution.selector)}` };
  }

  // Give a caller with step history (the autonomous loop) a chance to
  // veto this resolution before anything happens on the device. Found
  // for real: a "type the password" instruction with no visible
  // password field on screen resolved to the SAME element an earlier
  // "type the Yes Number" step had already filled, silently
  // overwriting it and making the subsequent "tap Login" a no-op. A
  // resolver picking the only field it can see is "confident" in the
  // sense resolveSemanticAction() checks for, but reusing a field a
  // prior step already set is exactly the kind of wrong-but-confident
  // guess spec §2 argues an unattended run must not make -- so this
  // hook lets the loop refuse it and stop instead of clobbering.
  if (typeof options.beforeAct === "function") {
    const vetoReason = options.beforeAct({ selector: resolution.selector, selectorString, kind, text: options.text });
    if (vetoReason) {
      return { success: false, reason: vetoReason };
    }
  }

  const outcome = await actAndDiff(driver, selectorString, kind, options.text, pageSourceBefore, { settleMs: options.actSettleMs, sleep: options.sleep, expect: options.expect, outcomeSettleTimeoutMs: options.outcomeSettleTimeoutMs, outcomeSettlePollMs: options.outcomeSettlePollMs });
  if (!outcome.success) {
    return outcome;
  }

  // Framework-level self-heal: a "tap" that produced literally no
  // change to the screen is a concrete, already-observed signal (not a
  // guess) that the resolved element was the wrong one -- a dead-end
  // control, or one that looked like a confident match but does
  // nothing. Rather than report this "success" and let a caller (or a
  // human reading a log afterwards) discover the mistake later, retry
  // resolution ONCE, live, on the SAME captured screen, with that exact
  // element excluded (resolveSemanticAction's excludedRefs) so the
  // model can't just pick it again. Scoped to "tap" only: a "type"
  // producing no visible change is a different, separately-handled
  // situation (see docs/STATUS.md/semantic-loop.js's own no-op
  // handling), and scroll/tapIfExists never reach this path at all.
  // This does NOT catch a wrong-but-functional click (one that *does*
  // visibly change the screen, just not the way the instruction meant
  // -- docs/STATUS.md bugs #13-#18) -- there is no diff-based signal
  // that a click was "successful but semantically wrong" the way there
  // is for "did literally nothing". That class still needs either
  // tapIfExists (an exact, evidence-backed selector, no judgment call)
  // or real outcome verification against an expected end state (the
  // still-unbuilt requirement-traceability layer) -- this is a narrower,
  // already-provable fix for a narrower, already-provable failure mode.
  if (kind === "tap" && outcome.diffSummary === "No visible change.") {
    const retryResolution = await resolveSemanticAction(pageSourceBefore, instruction, {
      screenshotBase64,
      kind,
      excludedRefs: [resolution.element.ref],
    });
    if (retryResolution.resolved) {
      const retrySelectorString = buildSelector(retryResolution.selector, platform);
      if (retrySelectorString) {
        let retryVetoReason;
        if (typeof options.beforeAct === "function") {
          retryVetoReason = options.beforeAct({ selector: retryResolution.selector, selectorString: retrySelectorString, kind, text: options.text });
        }
        if (!retryVetoReason) {
          const retryOutcome = await actAndDiff(driver, retrySelectorString, kind, options.text, pageSourceBefore, { settleMs: options.actSettleMs, sleep: options.sleep, expect: options.expect, outcomeSettleTimeoutMs: options.outcomeSettleTimeoutMs, outcomeSettlePollMs: options.outcomeSettlePollMs });
          if (retryOutcome.success && retryOutcome.diffSummary !== "No visible change.") {
            return {
              ...retryOutcome,
              selector: retryResolution.selector,
              healedFromCache: Boolean(options.cachedSelector),
              selfHealedNoOp: true,
              // The ORIGINAL selector that produced "No visible
              // change." -- kept separately from `selector` above
              // (which is now the HEALED, working one) so
              // generation/execution-log.js's buildExecutionRecord can
              // log the dead end that was actually found, not just the
              // good outcome that replaced it. Consumed cross-run by
              // getDeadSelectors()/resolveSemanticAction() to exclude
              // this exact resource-id/accessibility-id/text from this
              // instruction's candidates on every future run, not just
              // the rest of this one.
              deadSelector: resolution.selector,
            };
          }
        }
      }
    }
    // No better alternative found (nothing else resolved, the retry
    // was also a no-op, or it was vetoed) -- fall through and report
    // the original, honest outcome rather than inventing a result.
  }

  return {
    ...outcome,
    selector: resolution.selector,
    // Signals the caller (test-case-runner's selector cache) that this
    // selector should be written back -- either as a brand-new cache
    // entry, or replacing a cached one that just proved stale.
    healedFromCache: Boolean(options.cachedSelector),
  };
}

/**
 * Acts on an already-built selector string (click or setValue) and
 * reports the before/after diff -- the part of resolution shared by
 * both the cached-selector replay path and the full semantic-
 * resolution path above, so neither can drift out of sync with the
 * other's staleness/diffing behavior.
 *
 * @param {import('webdriverio').Browser} driver
 * @param {string} selectorString
 * @param {"tap"|"type"} kind
 * @param {string} [text] - required when kind is "type".
 * @param {string} pageSourceBefore
 * @param {Object} [settleOptions]
 * @param {number} [settleOptions.settleMs] - delay before reading the
 *   post-action page source, "tap" only. Defaults to
 *   DEFAULT_ACT_SETTLE_DELAY_MS (env override: TESTOPS_MOBILE_ACT_SETTLE_MS).
 *   0 disables it outright.
 * @param {(ms: number) => Promise<void>} [settleOptions.sleep] - real
 *   timer by default; tests inject a no-op/instant fake so the suite
 *   doesn't actually wait.
 * @param {Object} [settleOptions.expect] - the step's declared outcome
 *   (generation/outcome-verification.js's `{appeared?, disappeared?}`
 *   shape), when the caller has one. "tap" only, same as the settle
 *   delay above: when given and it doesn't hold right after the settle
 *   delay, keeps polling/re-diffing (see DEFAULT_OUTCOME_SETTLE_TIMEOUT_MS's
 *   comment) instead of returning the first, possibly-still-loading diff.
 * @param {number} [settleOptions.outcomeSettleTimeoutMs] - total extra
 *   time budget for that polling. Defaults to
 *   DEFAULT_OUTCOME_SETTLE_TIMEOUT_MS (env override:
 *   TESTOPS_MOBILE_OUTCOME_SETTLE_TIMEOUT_MS). 0 disables it outright.
 * @param {number} [settleOptions.outcomeSettlePollMs] - interval between
 *   polls. Defaults to DEFAULT_OUTCOME_SETTLE_POLL_MS (env override:
 *   TESTOPS_MOBILE_OUTCOME_SETTLE_POLL_MS).
 * @returns {Promise<{success: boolean, reason?: string, diff?: object, diffSummary?: string, assertions?: Array}>}
 */

/**
 * Confirms a "type" action actually landed in a real input field,
 * rather than trusting setValue()'s lack of a thrown error. See the
 * doc comment at this function's call site in actAndDiff() for the
 * real bug (addons-run-ios-docker-8.log, bug #6) this closes.
 *
 * Best-effort and permissive by design -- this is a safety net against
 * a clearly-wrong resolution, not a strict assertion on every driver
 * shim: an older/minimal fake driver (most of this file's own test
 * fixtures) with no `getText()` at all, or a real one where reading it
 * back genuinely fails (a transition mid-flight), is treated as
 * "can't verify" and passed through rather than failed -- the read-
 * back is extra assurance, not a new way for a perfectly good action
 * to be reported as broken.
 *
 * Credential-safe, same standard as generation/execution-log.js's
 * buildExecutionRecord(): the failure reason this returns NEVER
 * includes the real typed text or the field's real displayed value,
 * only their lengths -- a mismatch on a password/phone-number field
 * must never leak the credential into a log line.
 *
 * @param {Object} element - the WebdriverIO-shaped element just acted on.
 * @param {string} text - what was sent to setValue().
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function verifyTypedValue(element, text) {
  if (typeof element.getText !== "function") {
    return { ok: true };
  }
  let actual;
  try {
    actual = await element.getText();
  } catch (_err) {
    return { ok: true };
  }
  if (typeof actual !== "string" || actual === text) {
    return { ok: true };
  }
  // A masked secure field never echoes the real text back -- iOS/
  // Android both display a run of identical mask characters (bullets,
  // dots, asterisks) in its place. Same length, no alphanumerics:
  // treat as the expected masked echo, not a mismatch.
  if (actual.length === text.length && actual.length > 0 && /^(.)\1*$/.test(actual) && !/[a-zA-Z0-9]/.test(actual)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `typed text was not found in the field afterward (sent ${text.length} character(s), field now shows ${actual.length} character(s)) -- the resolved element may not be the real input field`,
  };
}

/**
 * Attempts one tap/type action inside a live WebView context, end to
 * end: switch in, collect the DOM, resolve the instruction against it
 * (generation/webview-act.js), act, switch back out -- ALWAYS switches
 * back to NATIVE_APP before returning, success or failure, so a later
 * native step is never silently left stuck in the wrong context.
 *
 * Returns `null` (not a result object) for "no usable answer from the
 * WebView" -- couldn't switch into it, couldn't read its DOM, or the
 * model declined to match anything -- which the caller treats as
 * "nothing happened here, fall through to native resolution", not a
 * failure. Only returns a real `{success, ...}` result on an actual
 * WebView success, or a genuine WebView-side action failure (a vetoed
 * resolution, the resolved element vanishing before the click, or the
 * click/setValue itself throwing) -- those ARE final answers, not a
 * reason to also try native.
 *
 * Deliberately does not attempt page-source diffing or outcome-settle
 * polling the way the native actAndDiff() path does: getPageSource()
 * while switched into a WEBVIEW context returns the page's HTML, not
 * the native accessibility-tree XML semantic-diff.js/outcome-
 * verification.js are built to parse, and feeding HTML into a native-
 * tree diff would silently produce meaningless results rather than an
 * honest "not computed" -- the diffSummary below says exactly that,
 * rather than claiming a diff that was never actually taken.
 *
 * @param {import('webdriverio').Browser} driver
 * @param {string} webviewContext - a real WEBVIEW_* name from
 *   detectWebviewContext(), never invented.
 * @param {string} instruction
 * @param {Object} options - the same options executeSemanticAction()
 *   received (kind, text, beforeAct).
 * @param {"tap"|"type"} kind
 * @returns {Promise<null|SemanticActionExecutionResult & {viaWebview: true}>}
 */
async function tryWebviewAction(driver, webviewContext, instruction, options, kind) {
  try {
    await driver.switchContext(webviewContext);
  } catch (err) {
    // Couldn't actually switch -- treat exactly like "no webview here",
    // not a failure worth reporting as the step's own outcome.
    return null;
  }
  try {
    let domElements;
    try {
      domElements = await driver.execute(SERIALIZE_DOM_SCRIPT);
    } catch (err) {
      return null;
    }
    const resolution = await resolveWebviewAction(domElements, instruction, { kind });
    if (!resolution.resolved) {
      return null;
    }
    const selectorString = resolution.selector.value;
    if (typeof options.beforeAct === "function") {
      const vetoReason = options.beforeAct({ selector: resolution.selector, selectorString, kind, text: options.text });
      if (vetoReason) {
        return { success: false, reason: vetoReason, selector: resolution.selector, viaWebview: true };
      }
    }
    let element;
    try {
      element = await driver.$(selectorString);
      const exists = await element.isExisting();
      if (!exists) {
        return null; // vanished between resolve and act -- fall back to native rather than fail outright
      }
      if (kind === "type") {
        await element.setValue(options.text);
      } else {
        await element.click();
      }
    } catch (err) {
      return { success: false, reason: `WebView action failed: ${err.message}`, selector: resolution.selector, viaWebview: true };
    }
    return {
      success: true,
      selector: resolution.selector,
      viaWebview: true,
      diffSummary: "(WebView action -- page-source diffing not computed; see tryWebviewAction's doc comment)",
    };
  } finally {
    try {
      await driver.switchContext("NATIVE_APP");
    } catch (err) {
      // Best-effort restore. If this itself fails, nothing in this
      // module depends on it having succeeded here -- a subsequent
      // native call will surface its own clear error if the session is
      // genuinely stuck in the wrong context.
    }
  }
}

async function actAndDiff(driver, selectorString, kind, text, pageSourceBefore, settleOptions = {}) {
  const sleep = settleOptions.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const envSettleMs = Number(process.env.TESTOPS_MOBILE_ACT_SETTLE_MS);
  const settleMs = settleOptions.settleMs ?? (Number.isFinite(envSettleMs) ? envSettleMs : DEFAULT_ACT_SETTLE_DELAY_MS);
  try {
    const element = await driver.$(selectorString);
    // Confirm the element is actually there before acting on it -- the
    // screen may have moved on between the snapshot and now (an
    // animation finishing, a toast dismissing itself), and a stale
    // resolution acting blind is exactly the kind of wrong guess spec
    // §2 argues an unattended agent must not make.
    const exists = await element.isExisting();
    if (!exists) {
      return { success: false, reason: `resolved element (${selectorString}) is no longer on screen` };
    }

    if (kind === "tap") {
      await element.click();
    } else {
      await element.setValue(text);
    }

    // Read-back verification -- found for real on a live BrowserStack
    // iOS run (addons-run-ios-docker-8.log, bug #6): "type the phone
    // number" resolved to a genuinely dead, hidden element (an
    // XCUIElementTypeOther with visible="false" accessible="false", the
    // keyboard's own hidden input accessory). setValue() against it
    // returned successfully -- no WebDriver error at all -- so the step
    // was reported as a success while the real field almost certainly
    // never got the right value. That bug is now fixed upstream
    // (buildGroundedSnapshot() excludes that specific dead-element
    // shape), but relying solely on "the candidate list was clean" is
    // fragile against the next not-yet-seen variant of the same
    // failure mode: a resolved-but-wrong element whose setValue() call
    // simply doesn't throw. This closes the gap generically, for any
    // future case, by checking the actual result rather than trusting
    // a silent success: immediately after typing, read the field's own
    // displayed value back and confirm it reflects what was sent,
    // rather than discovering the mismatch minutes later as an
    // unrelated downstream failure (there, a real "Invalid
    // username/password entered" from the app itself).
    if (kind === "type") {
      const verification = await verifyTypedValue(element, text);
      if (!verification.ok) {
        return { success: false, reason: verification.reason };
      }
    }
  } catch (err) {
    return { success: false, reason: `action failed: ${err.message}` };
  }

  // Only "tap" gets the settle delay -- see DEFAULT_ACT_SETTLE_DELAY_MS's
  // comment for why (a tap can trigger a full-screen transition/popup
  // that takes a moment to render; a keystroke doesn't).
  if (kind === "tap" && settleMs > 0) {
    await sleep(settleMs);
  }

  let pageSourceAfter;
  try {
    pageSourceAfter = await driver.getPageSource();
  } catch (err) {
    // The action itself succeeded; only the post-action read failed
    // (e.g. the app crashed, or a transition is mid-flight). Report
    // success with what we know rather than failing an action that did
    // work -- but without a diff, since there's nothing to diff against.
    return { success: true };
  }

  let diff = diffSnapshots(pageSourceBefore, pageSourceAfter);

  // Outcome-settle retry -- see DEFAULT_OUTCOME_SETTLE_TIMEOUT_MS's
  // comment. Only engages when the caller declared an `expect` AND it
  // doesn't already hold; a step with no declared outcome, or one that
  // already matches, never pays this extra wait.
  if (kind === "tap" && settleOptions.expect && !verifyExpectedOutcome(diff, settleOptions.expect).ok) {
    const envTimeoutMs = Number(process.env.TESTOPS_MOBILE_OUTCOME_SETTLE_TIMEOUT_MS);
    const envPollMs = Number(process.env.TESTOPS_MOBILE_OUTCOME_SETTLE_POLL_MS);
    const timeoutMs = settleOptions.outcomeSettleTimeoutMs ?? (Number.isFinite(envTimeoutMs) ? envTimeoutMs : DEFAULT_OUTCOME_SETTLE_TIMEOUT_MS);
    const pollMs = settleOptions.outcomeSettlePollMs ?? (Number.isFinite(envPollMs) ? envPollMs : DEFAULT_OUTCOME_SETTLE_POLL_MS);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      let polledPageSource;
      try {
        polledPageSource = await driver.getPageSource();
      } catch (_err) {
        continue; // mid-transition read failures are expected -- keep polling.
      }
      const polledDiff = diffSnapshots(pageSourceBefore, polledPageSource);
      if (verifyExpectedOutcome(polledDiff, settleOptions.expect).ok) {
        diff = polledDiff;
        break;
      }
      diff = polledDiff; // keep the most recent read even if it never passes, so a genuine failure still reports real evidence.
    }
  }

  return {
    success: true,
    diff,
    diffSummary: diffToText(diff),
    // Closes spec §6's "state-diff reporting... feeds the assertion-
    // inference step directly" -- see generation/semantic-assertions.js.
    // Always computed (cheap, pure) so a caller building up a test case
    // or a report doesn't need its own separate call for it.
    assertions: inferSemanticAssertions(diff),
  };
}

/**
 * Performs a native scroll/swipe gesture and reports the before/after
 * diff, the same shape a tap/type success returns (minus `selector`,
 * since there is no single resolved element). Direction defaults to
 * "down" (the common case: revealing more of a list below the fold).
 * Window size is read defensively -- not every driver/mock implements
 * `getWindowSize()`, and a reasonable default rect is still far better
 * than failing the step outright over a missing viewport size.
 *
 * @param {import('webdriverio').Browser} driver
 * @param {string} pageSourceBefore - already captured by the caller.
 * @param {Object} options
 * @param {"up"|"down"} [options.direction] - defaults to "down".
 * @param {"android"|"ios"} platform
 * @returns {Promise<SemanticActionExecutionResult>}
 */
async function performScroll(driver, pageSourceBefore, options, platform) {
  const direction = options.direction === "up" ? "up" : "down";

  let width = 1080;
  let height = 2200;
  try {
    const size = await driver.getWindowSize();
    if (size && Number.isFinite(size.width) && Number.isFinite(size.height)) {
      width = size.width;
      height = size.height;
    }
  } catch (err) {
    // Fall back to the defaults above -- see doc comment.
  }

  try {
    if (platform === "ios") {
      await driver.execute("mobile: scroll", { direction });
    } else {
      // UiAutomator2's scrollGesture: swipe within a rect comfortably
      // inside the screen edges (avoids system nav/status bars and
      // edge-swipe gestures that could trigger back navigation).
      await driver.execute("mobile: scrollGesture", {
        left: Math.round(width * 0.1),
        top: Math.round(height * 0.2),
        width: Math.round(width * 0.8),
        height: Math.round(height * 0.6),
        direction,
        percent: 0.75,
      });
    }
  } catch (err) {
    return { success: false, reason: `scroll failed: ${err.message}` };
  }

  let pageSourceAfter;
  try {
    pageSourceAfter = await driver.getPageSource();
  } catch (err) {
    // The gesture itself succeeded; only the post-action read failed --
    // same reasoning as the tap/type path above.
    return { success: true };
  }

  const diff = diffSnapshots(pageSourceBefore, pageSourceAfter);
  return {
    success: true,
    diff,
    diffSummary: diffToText(diff),
    assertions: inferSemanticAssertions(diff),
  };
}

module.exports = { executeSemanticAction };
