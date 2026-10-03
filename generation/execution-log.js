/**
 * Automatic execution-logging for the semantic layer. Explicit
 * direction from the user: manual log-reading to diagnose and fix the
 * resolver (the loop that closed `test-cases/addons.json`'s 18 bugs by
 * hand) has to become a framework capability -- every execution should
 * capture itself as structured, trainable data with zero human step,
 * wired into the semantic layer itself, not a wrapper script tied to
 * one person's machine or one log source.
 *
 * Scope, stated plainly so this isn't oversold: this module is the
 * piece of "train the model on every execution" that's honestly
 * automatable right now -- capturing what happened. It does NOT change
 * any model weights, and it shouldn't: an LLM's weights only change via
 * an offline fine-tuning job (GPU compute, a training toolchain), and
 * doing that unreviewed after every single execution would mean a bad
 * run could silently degrade the model with nobody checking -- the
 * opposite of this codebase's "never guess, always verify" discipline
 * (see docs/STATUS.md's false-success bugs #16/#18). The honest
 * pipeline this module is step 1 of: automatic capture (this file) ->
 * a periodic, automatic fine-tune job over the accumulated data -> an
 * automatic regression-test gate (replay the known bugs) before a new
 * model ever replaces the live one. Steps 2-3 need a training
 * toolchain and GPU infra this sandbox doesn't have -- see
 * docs/CONTINUOUS_TRAINING.md for that design. Old records past a 15-day retention window (configurable, PHOENIX_TRAINING_LOG_RETENTION_DAYS) are pruned automatically too -- once a training cycle has consumed them, the log itself doesn't need to be kept indefinitely, with no separate cleanup job to remember to run.
 */

const fs = require("fs");
const path = require("path");

/**
 * Where execution records are appended, one JSON object per line
 * (JSONL -- easy to append to, easy to stream into a training job
 * later without parsing a giant array). Configurable so a real
 * deployment can point this at a shared volume/log pipeline instead of
 * a local file; defaults to a path inside the repo so it works
 * out-of-the-box in dev.
 */
function logPath() {
  return process.env.PHOENIX_TRAINING_LOG_PATH || path.join(process.cwd(), "training-data", "executions.jsonl");
}

/**
 * How long a logged execution is kept before automatic cleanup removes
 * it. Explicit requirement: once a run of training has consumed the
 * log, the log itself shouldn't need to be kept around indefinitely --
 * wired into the framework itself (no external cron job, no manual
 * "remember to clean this up" step), defaulting to 15 days.
 */
function retentionDays() {
  const raw = process.env.PHOENIX_TRAINING_LOG_RETENTION_DAYS;
  const parsed = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15;
}

/**
 * Where the "last cleanup ran at" marker lives -- a sentinel file next
 * to the log itself, not a separate config entry, so the two always
 * travel together and a copied/moved log directory keeps working
 * without extra setup.
 */
function sentinelPath() {
  return `${logPath()}.last-prune`;
}

/**
 * Removes log records older than retentionDays() from the log file,
 * keeping everything newer. Deliberately tolerant of a record with no
 * parseable `loggedAt` (kept rather than dropped) or a corrupt line
 * (dropped silently, same as getPastFailures()'s own tolerance) --
 * cleanup must never be the reason real data disappears unexpectedly.
 *
 * Exported directly (not just invoked automatically) so it can also be
 * run on demand -- a manual `node -e "require('./execution-log').pruneOldExecutions()"`,
 * or wired into whatever periodic job a real deployment already has --
 * without that being the ONLY way it runs.
 *
 * @returns {{kept: number, removed: number} | undefined} undefined if
 *   there was nothing to prune (no log file yet) or the operation
 *   failed (fail-soft, logged, never thrown).
 */
function pruneOldExecutions() {
  try {
    const filePath = logPath();
    if (!fs.existsSync(filePath)) return undefined;

    const cutoff = Date.now() - retentionDays() * 24 * 60 * 60 * 1000;
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    const keptLines = [];
    let removed = 0;

    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        removed += 1; // corrupt line -- drop it, same tolerance as getPastFailures()
        continue;
      }
      const loggedAtMs = record.loggedAt ? Date.parse(record.loggedAt) : NaN;
      if (Number.isFinite(loggedAtMs) && loggedAtMs < cutoff) {
        removed += 1;
      } else {
        keptLines.push(line);
      }
    }

    if (removed > 0) {
      fs.writeFileSync(filePath, keptLines.length > 0 ? keptLines.join("\n") + "\n" : "");
    }
    return { kept: keptLines.length, removed };
  } catch (err) {
    console.warn("[generation/execution-log] couldn't prune old executions (continuing anyway):", err.message);
    return undefined;
  }
}

/**
 * Runs pruneOldExecutions() automatically, but only roughly once per
 * retention window -- checked via the sentinel file -- so logging
 * itself doesn't pay the cost of re-scanning and rewriting the whole
 * log on every single execution. This is what makes cleanup a
 * framework capability rather than a cron job someone has to remember
 * to set up: it piggybacks on ordinary usage (any call to
 * logExecution), so as long as Phoenix is being run at all, the log
 * stays bounded with zero separate scheduling step.
 */
function maybePruneOldExecutions() {
  try {
    const sentinel = sentinelPath();
    const dueMs = retentionDays() * 24 * 60 * 60 * 1000;
    let lastPrunedMs = 0;
    if (fs.existsSync(sentinel)) {
      lastPrunedMs = Date.parse(fs.readFileSync(sentinel, "utf8").trim()) || 0;
    }
    if (Date.now() - lastPrunedMs < dueMs) return; // not due yet

    pruneOldExecutions();
    fs.writeFileSync(sentinel, new Date().toISOString());
  } catch (err) {
    // Never let a cleanup-scheduling problem block the actual log write.
    console.warn("[generation/execution-log] couldn't check/update prune schedule (continuing anyway):", err.message);
  }
}

/**
 * Appends one execution record. NEVER throws -- logging is a
 * side-channel; a disk-full or permissions error here must not fail
 * the actual test action it's describing. Returns true/false for
 * whether the write succeeded, purely informational.
 *
 * Also opportunistically runs the automatic retention cleanup (see
 * maybePruneOldExecutions()) -- cheap on every call (one sentinel file
 * read) and only actually rewrites the log on the rare call where the
 * retention window has elapsed, so this stays automatic without
 * needing a separate scheduled process.
 *
 * @param {Object} record - caller-built record (see
 *   buildExecutionRecord below for the shape used by the semantic
 *   layer specifically). Logged as-is, plus a `loggedAt` timestamp.
 * @returns {boolean}
 */
function logExecution(record) {
  try {
    const filePath = logPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const line = JSON.stringify({ ...record, loggedAt: new Date().toISOString() });
    fs.appendFileSync(filePath, line + "\n");
    maybePruneOldExecutions();
    return true;
  } catch (err) {
    // Fail-soft and loud-ish (console, not throw) -- see module doc.
    console.warn("[generation/execution-log] couldn't write execution record (continuing anyway):", err.message);
    return false;
  }
}

/**
 * Builds the record logged for one executeSemanticAction() call, from
 * its inputs and result. Centralized here (not duplicated at every
 * call site) so the schema only needs to change in one place.
 *
 * Credential safety, same standard as mergeResolvedSelectors
 * (run-batch-executions.js): a "type" step's `options.text` is, after
 * substitution, a REAL value -- a real phone number or password when
 * it came from `${PHOENIX_BATCH_LOGIN_PASSWORD}` etc. This NEVER logs
 * that value, only whether one was given and its length, so a training
 * dataset built from these logs can never leak a credential even if
 * the test-case author used one as a literal instead of an env
 * placeholder.
 *
 * @param {string} instruction
 * @param {Object} options - the options object executeSemanticAction()
 *   received (kind, text, cachedSelector, useVisualGrounding, etc).
 * @param {Object} result - whatever executeSemanticAction() is about
 *   to return.
 * @returns {Object}
 */
function buildExecutionRecord(instruction, options, result) {
  return {
    instruction,
    kind: options.kind || "tap",
    hadText: typeof options.text === "string",
    textLength: typeof options.text === "string" ? options.text.length : undefined,
    usedVisualGrounding: Boolean(options.useVisualGrounding),
    hadCachedSelector: Boolean(options.cachedSelector),
    // Outcome -- the actual training signal. `success`/`diffSummary`
    // are the ground truth a future fine-tune or regression-eval would
    // learn from or check against; usedCache/selfHealedNoOp/skipped
    // say which code path produced it, so "worked because the cache
    // already knew the answer" isn't confused with "the model resolved
    // it fresh and got it right."
    success: Boolean(result.success),
    reason: result.success ? undefined : result.reason,
    // Present only on a FAILED result that still went through the
    // one-retry-on-decline path (engine/semantic-act-executor.js):
    // firstAttemptReason is what the first, pre-retry decline actually
    // said, kept separately from `reason` (the final, post-retry
    // outcome) so neither is lost -- a run that failed twice for two
    // DIFFERENT reasons is a different, more interesting fact than one
    // that failed the same way twice, and this is what preserves that
    // distinction in the log.
    firstAttemptReason: result.retried ? result.firstAttemptReason : undefined,
    retried: result.retried ? true : undefined,
    selector: result.selector,
    // The ORIGINAL selector that produced "No visible change." before
    // a successful self-heal retry replaced it with result.selector
    // (the healed, working one) -- see executeSemanticActionInner's
    // self-heal block in engine/semantic-act-executor.js, which sets
    // this explicitly on a healed result. Without capturing it
    // separately here, the dead-end selector that CAUSED the heal was
    // silently lost the moment the heal succeeded -- the record only
    // ever showed the good outcome, with no trace of what to avoid
    // next time. This is what getDeadSelectors() below reads back.
    deadSelector: result.deadSelector,
    diffSummary: result.diffSummary,
    usedCache: Boolean(result.usedCache),
    healedFromCache: Boolean(result.healedFromCache),
    selfHealedNoOp: Boolean(result.selfHealedNoOp),
    skipped: Boolean(result.skipped),
  };
}

/**
 * Reads back past failures for the SAME instruction, so a fresh
 * resolveSemanticAction() call can take them into account -- the other
 * half of "automatic, no human in the loop" that just logging misses:
 * a log nobody reads back is a diary, not a feedback loop. This is the
 * part of continuous improvement that genuinely runs instantly, on any
 * hardware, with no training job and no GPU -- it's a plain file read
 * plus a filter, not a model update. See docs/CONTINUOUS_TRAINING.md
 * §2(b) for why this (prompt-level retrieval) is the realistic
 * "learns from every execution" mechanism on CPU-only hardware, versus
 * §2(a) (actual weight fine-tuning, which is NOT instant regardless of
 * data cleanliness -- a compute-bound cost, not a data-quality one).
 *
 * Deliberately soft, not a hard filter: a past failure is a HINT passed
 * into the prompt ("this was tried before and didn't work"), never a
 * silent exclusion of a candidate. The screen can genuinely change
 * between runs (an app update, a different account state) such that a
 * previously-wrong element becomes the right one -- hard-excluding it
 * forever from a log entry would risk permanently blinding the
 * resolver to a real match for a reason that no longer holds. Scoped
 * to exact instruction-string matches only (test-case wording is
 * static), and only genuine failures (success: false) -- a self-healed
 * run already found a working answer another way (cached next time),
 * so there's no actionable "what went wrong" to surface from it today
 * without deeper plumbing to capture the pre-heal attempt separately
 * (noted as a follow-up in docs/CONTINUOUS_TRAINING.md).
 *
 * @param {string} instruction
 * @param {Object} [options]
 * @param {number} [options.limit] - most recent N failures to return
 *   (default 3) -- enough to be useful context, not so many the prompt
 *   balloons or old, since-fixed failures crowd out the current ones.
 * @returns {Array<{reason: string|undefined, diffSummary: string|undefined, selector: Object|undefined, loggedAt: string}>}
 */
function getPastFailures(instruction, options = {}) {
  const limit = options.limit || 3;
  try {
    const filePath = logPath();
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    const failures = [];
    // Walk from the end -- most recent first -- so a stale early
    // failure doesn't crowd out a more recent, more relevant one once
    // `limit` is reached.
    for (let i = lines.length - 1; i >= 0 && failures.length < limit; i -= 1) {
      let record;
      try {
        record = JSON.parse(lines[i]);
      } catch {
        continue; // tolerate a corrupt/partial line rather than failing the whole read
      }
      if (record.instruction === instruction && record.success === false) {
        failures.push({
          reason: record.reason,
          diffSummary: record.diffSummary,
          selector: record.selector,
          loggedAt: record.loggedAt,
        });
      }
    }
    return failures;
  } catch (err) {
    // Fail-soft, same contract as logExecution: a corrupt/unreadable
    // log must never block resolution, only lose this one piece of
    // helpful context.
    console.warn("[generation/execution-log] couldn't read past failures (continuing without them):", err.message);
    return [];
  }
}

/**
 * Reads back selectors already proven to be dead-end taps for the SAME
 * instruction, across runs -- the cross-run extension of the in-run
 * `excludedRefs` self-heal (engine/semantic-act-executor.js), flagged
 * as the next concrete increment in docs/CONTINUOUS_TRAINING.md §2(b):
 * "if a resolved selector is later found to be a dead-end ... record it
 * the same way resolvedSelector is recorded today, and exclude it from
 * candidates on every future run for that step."
 *
 * Two kinds of record count as a proven dead end for this instruction:
 *   1. A final (never healed) result: `kind: "tap"`, `success: true`,
 *      `diffSummary: "No visible change."`, and NOT `selfHealedNoOp` --
 *      that run's own `selector` IS the dead end (no better candidate
 *      was ever found to replace it).
 *   2. A healed result (`selfHealedNoOp: true`): its `deadSelector`
 *      field (not `selector`, which is the HEALED, working one) is the
 *      dead end.
 *
 * Unlike getPastFailures() above, this is intentionally a HARD
 * exclusion, not a soft hint -- see where it's consumed
 * (generation/semantic-act.js) for why that's still safe: a dead tap
 * is a concrete, already-observed "this control does nothing" fact
 * about a specific resource-id/accessibility-id/text, not a judgment
 * call about whether an instruction was understood correctly, so
 * there's no risk of permanently blinding the resolver to a
 * legitimately different interpretation the way hard-excluding a
 * *failure* might. If the screen genuinely changes such that the same
 * selector string now points at a different, real control, this list
 * naturally stops matching anything in the live snapshot (matched by
 * resource-id/accessibility-id/text value, not by position) -- it
 * never actively blocks a real match, it just never offers a value this
 * exact instruction has already proven useless on a prior screen.
 *
 * @param {string} instruction
 * @param {Object} [options]
 * @param {number} [options.limit] - most recent N distinct dead
 *   selectors to return (default 5).
 * @returns {Array<{strategy: string, value: string}>}
 */
function getDeadSelectors(instruction, options = {}) {
  const limit = options.limit || 5;
  try {
    const filePath = logPath();
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    const seen = new Set();
    const deadSelectors = [];
    // Walk from the end -- most recent first, same convention as
    // getPastFailures() -- so a long-since-fixed dead end (app updated,
    // control is now functional) doesn't crowd out a more recent one.
    for (let i = lines.length - 1; i >= 0 && deadSelectors.length < limit; i -= 1) {
      let record;
      try {
        record = JSON.parse(lines[i]);
      } catch {
        continue; // tolerate a corrupt/partial line, same as getPastFailures()
      }
      if (record.instruction !== instruction || record.kind !== "tap") continue;

      let candidate;
      if (record.selfHealedNoOp && record.deadSelector) {
        candidate = record.deadSelector;
      } else if (record.success === true && record.diffSummary === "No visible change." && !record.selfHealedNoOp) {
        candidate = record.selector;
      }
      if (!candidate || !candidate.strategy || !candidate.value) continue;

      const key = `${candidate.strategy}:${candidate.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deadSelectors.push({ strategy: candidate.strategy, value: candidate.value });
    }
    return deadSelectors;
  } catch (err) {
    // Fail-soft, same contract as getPastFailures(): a corrupt/unreadable
    // log must never block resolution, only lose this one piece of
    // helpful context.
    console.warn("[generation/execution-log] couldn't read dead selectors (continuing without them):", err.message);
    return [];
  }
}

/**
 * Reads back selectors already proven, on a PRIOR run of the SAME
 * instruction, to be a "wrong but functional click" -- the parallel
 * exclusion case to getDeadSelectors() above, for the other half of
 * the #13-#18 "wrong but functional click" bug class (docs/STATUS.md,
 * generation/outcome-verification.js's module doc): a tap that
 * produces a real, non-empty diff (so it's NOT a dead tap -- something
 * genuinely happened) but whose step had a declared `expect` that
 * still didn't hold, even after engine/semantic-act-executor.js's
 * outcome-settle retry gave it every chance to. That combination can
 * only mean the tap landed on the wrong real control, not a timing
 * race or a no-op.
 *
 * Reads records written with `expectFailed: true` -- see
 * engine/test-case-runner.js's runScriptSteps(), the only writer: it's
 * the one place that both knows a step declared an `expect` AND has
 * already re-checked verifyExpectedOutcome() against the diff the
 * outcome-settle retry (if any) produced, so this never has to
 * re-derive "did the retry already happen" here. That record's own
 * `selector` (NOT `deadSelector`, which this bug class has no use for
 * -- there is no "original, since-healed" selector here, just the one
 * real, wrong click) is the proven-wrong-outcome candidate.
 *
 * Same hard-exclusion reasoning as getDeadSelectors(): a selector that
 * produced a real diff but never satisfied its step's own declared
 * outcome, even after a generous settle-retry window, is a concrete,
 * already-observed fact about a specific resource-id/accessibility-id/
 * text ("this control is not the one the instruction means"), not a
 * judgment call -- safe to exclude outright rather than only hint at.
 *
 * @param {string} instruction
 * @param {Object} [options]
 * @param {number} [options.limit] - most recent N distinct
 *   expect-failed selectors to return (default 5).
 * @returns {Array<{strategy: string, value: string}>}
 */
function getExpectFailedSelectors(instruction, options = {}) {
  const limit = options.limit || 5;
  try {
    const filePath = logPath();
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    const seen = new Set();
    const expectFailedSelectors = [];
    // Walk from the end -- most recent first, same convention as
    // getDeadSelectors()/getPastFailures() -- so a long-since-fixed
    // mis-match (the app changed, the real control moved) doesn't crowd
    // out a more recent one.
    for (let i = lines.length - 1; i >= 0 && expectFailedSelectors.length < limit; i -= 1) {
      let record;
      try {
        record = JSON.parse(lines[i]);
      } catch {
        continue; // tolerate a corrupt/partial line, same as getDeadSelectors()
      }
      if (record.instruction !== instruction || record.kind !== "tap" || !record.expectFailed) continue;

      const candidate = record.selector;
      if (!candidate || !candidate.strategy || !candidate.value) continue;

      const key = `${candidate.strategy}:${candidate.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      expectFailedSelectors.push({ strategy: candidate.strategy, value: candidate.value });
    }
    return expectFailedSelectors;
  } catch (err) {
    // Fail-soft, same contract as getDeadSelectors().
    console.warn("[generation/execution-log] couldn't read expect-failed selectors (continuing without them):", err.message);
    return [];
  }
}

/**
 * Reads back successful past resolutions for the SAME instruction --
 * the positive-evidence counterpart to getPastFailures() above.
 * Explicit direction from the user: past executions should feed back
 * into the LLM, not just failures. A past success is the strongest
 * evidence available that a given selector is the right real-world
 * answer to this exact instruction (stronger than the hard
 * dead/expect-failed exclusions above, which only ever remove a wrong
 * candidate -- this surfaces the right one as a positive few-shot hint
 * the model reads directly in its prompt).
 *
 * Deliberately a soft hint, same contract as getPastFailures(): the
 * screen can genuinely change between runs (an app update moves the
 * element, a different account state removes it), so this is never a
 * hard override of what resolveSemanticAction() actually sees on the
 * live candidate list -- a stale success that no longer matches
 * anything on screen simply has no effect. A genuinely still-correct,
 * still-present success is also the ideal case for upgrading this step
 * to a pinned `resolvedSelector` in the test-case file instead (see
 * docs/STATUS.md's iOS LOGIN/PASSWORD pins) -- that removes the LLM
 * call for the step entirely, which is strictly better than reminding
 * the model every time. This hint exists for the steps NOT yet pinned
 * that way, or that can't be (e.g. an instruction whose correct element
 * genuinely varies by screen state).
 *
 * Scoped to exact instruction-string matches only (same as
 * getPastFailures()), successes only (`success: true`), and explicitly
 * excludes a self-healed run's PRE-heal attempt and any cache hit
 * (`usedCache`) -- a cache hit didn't involve the model making a
 * judgment call at all, so it has nothing to teach a *fresh* resolution
 * about matching an instruction to a candidate list; only a run where
 * the model itself picked correctly from scratch is useful few-shot
 * evidence of that skill.
 *
 * @param {string} instruction
 * @param {Object} [options]
 * @param {number} [options.limit] - most recent N distinct successful
 *   selectors to return (default 3) -- enough to reinforce a pattern
 *   without crowding the prompt or implying more certainty than one or
 *   two real confirmations warrant.
 * @returns {Array<{selector: {strategy: string, value: string}, loggedAt: string}>}
 */
function getPastSuccesses(instruction, options = {}) {
  const limit = options.limit || 3;
  try {
    const filePath = logPath();
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    const seen = new Set();
    const successes = [];
    // Walk from the end -- most recent first, same convention as every
    // other reader in this file -- so a long-stale success (the app has
    // since changed) doesn't crowd out a more recent confirmation.
    for (let i = lines.length - 1; i >= 0 && successes.length < limit; i -= 1) {
      let record;
      try {
        record = JSON.parse(lines[i]);
      } catch {
        continue; // tolerate a corrupt/partial line, same as every other reader here
      }
      if (record.instruction !== instruction || record.success !== true) continue;
      if (record.usedCache) continue; // a cache hit isn't the model exercising judgment
      const candidate = record.selector;
      if (!candidate || !candidate.strategy || !candidate.value) continue;

      const key = `${candidate.strategy}:${candidate.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      successes.push({ selector: { strategy: candidate.strategy, value: candidate.value }, loggedAt: record.loggedAt });
    }
    return successes;
  } catch (err) {
    // Fail-soft, same contract as every other reader in this file: a
    // corrupt/unreadable log must never block resolution, only lose
    // this one piece of helpful context.
    console.warn("[generation/execution-log] couldn't read past successes (continuing without them):", err.message);
    return [];
  }
}

module.exports = {
  logExecution,
  buildExecutionRecord,
  logPath,
  getPastFailures,
  getPastSuccesses,
  getDeadSelectors,
  getExpectFailedSelectors,
  pruneOldExecutions,
  retentionDays,
};
