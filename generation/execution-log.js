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
 * docs/CONTINUOUS_TRAINING.md for that design.
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
 * Appends one execution record. NEVER throws -- logging is a
 * side-channel; a disk-full or permissions error here must not fail
 * the actual test action it's describing. Returns true/false for
 * whether the write succeeded, purely informational.
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
    selector: result.selector,
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

module.exports = { logExecution, buildExecutionRecord, logPath, getPastFailures };
