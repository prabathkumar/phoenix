/**
 * Tests for generation/execution-log.js -- the automatic,
 * zero-manual-step capture of every semantic-layer execution. Covers
 * the two things that matter most: (1) it actually writes a
 * structured, appendable record, and (2) it NEVER logs a typed
 * credential's real value, only that one was given and its length --
 * the same credential-safety bar mergeResolvedSelectors already holds
 * selector caching to.
 *
 * Run with: npm test (from generation/) or `node test/execution-log.test.js`
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Point at an isolated temp file BEFORE requiring the module under
// test, so this never touches a real training-data/ directory
// (gitignored, but still shouldn't be written by a test run).
const TMP_LOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-exec-log-")), "executions.jsonl");
process.env.PHOENIX_TRAINING_LOG_PATH = TMP_LOG_PATH;

const { logExecution, buildExecutionRecord, logPath } = require("../execution-log");

function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function readLoggedLines() {
  if (!fs.existsSync(TMP_LOG_PATH)) return [];
  return fs
    .readFileSync(TMP_LOG_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("logPath() honors PHOENIX_TRAINING_LOG_PATH", () => {
  assert.strictEqual(logPath(), TMP_LOG_PATH);
});

test("logExecution appends a JSON line and returns true on success", () => {
  const before = readLoggedLines().length;
  const ok = logExecution({ instruction: "tap the LOGIN button", success: true });
  assert.strictEqual(ok, true);
  const after = readLoggedLines();
  assert.strictEqual(after.length, before + 1);
  assert.strictEqual(after[after.length - 1].instruction, "tap the LOGIN button");
  assert.ok(typeof after[after.length - 1].loggedAt === "string", "loggedAt timestamp should be stamped automatically");
});

test("logExecution creates the parent directory automatically (no manual setup step)", () => {
  const nestedPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-exec-log-nested-")), "a", "b", "c", "executions.jsonl");
  const original = process.env.PHOENIX_TRAINING_LOG_PATH;
  process.env.PHOENIX_TRAINING_LOG_PATH = nestedPath;
  try {
    // Re-require isn't needed -- logPath() reads the env var fresh
    // every call, so the module doesn't need reloading.
    const ok = logExecution({ instruction: "tap something" });
    assert.strictEqual(ok, true);
    assert.ok(fs.existsSync(nestedPath));
  } finally {
    process.env.PHOENIX_TRAINING_LOG_PATH = original;
  }
});

test("logExecution never throws, even when the path is unwritable", () => {
  const original = process.env.PHOENIX_TRAINING_LOG_PATH;
  // A path through a file (not a directory) as a path segment is not
  // writable/mkdir-able -- a reliable way to force a real fs error
  // without mocking fs internals.
  const blockerFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-exec-log-blocked-")), "not-a-directory");
  fs.writeFileSync(blockerFile, "i am a file, not a directory");
  process.env.PHOENIX_TRAINING_LOG_PATH = path.join(blockerFile, "executions.jsonl");
  try {
    let ok;
    assert.doesNotThrow(() => {
      ok = logExecution({ instruction: "this should fail softly" });
    });
    assert.strictEqual(ok, false);
  } finally {
    process.env.PHOENIX_TRAINING_LOG_PATH = original;
  }
});

test("buildExecutionRecord never includes a typed value's real text, only whether one was given and its length", () => {
  const record = buildExecutionRecord(
    "type the password into the password field",
    { kind: "type", text: "my-real-password-12345" },
    { success: true, selector: { strategy: "resource-id", value: "password_field" }, diffSummary: "Appeared: \"***\"." }
  );
  assert.strictEqual(record.hadText, true);
  assert.strictEqual(record.textLength, "my-real-password-12345".length);
  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes("my-real-password-12345"), "the real typed value must never appear in the logged record");
});

test("buildExecutionRecord reports hadText: false and no textLength when no text was given (a tap, not a type)", () => {
  const record = buildExecutionRecord("tap the LOGIN button", { kind: "tap" }, { success: true, selector: { strategy: "resource-id", value: "login_button" } });
  assert.strictEqual(record.hadText, false);
  assert.strictEqual(record.textLength, undefined);
});

test("buildExecutionRecord captures the failure reason and omits it on success", () => {
  const failed = buildExecutionRecord("tap the Checkout button", { kind: "tap" }, { success: false, reason: "no confident match" });
  assert.strictEqual(failed.success, false);
  assert.strictEqual(failed.reason, "no confident match");

  const succeeded = buildExecutionRecord("tap the Checkout button", { kind: "tap" }, { success: true, reason: "should never be read" });
  assert.strictEqual(succeeded.success, true);
  assert.strictEqual(succeeded.reason, undefined, "reason must be omitted on success even if the result object happens to carry a stale one");
});

test("buildExecutionRecord captures which code path produced the result (cache hit, self-heal, skip)", () => {
  const cacheHit = buildExecutionRecord("tap the LOGIN button", { kind: "tap", cachedSelector: { strategy: "resource-id", value: "x" } }, { success: true, usedCache: true });
  assert.strictEqual(cacheHit.usedCache, true);
  assert.strictEqual(cacheHit.hadCachedSelector, true);

  const healed = buildExecutionRecord("tap the LOGIN button", { kind: "tap" }, { success: true, selfHealedNoOp: true });
  assert.strictEqual(healed.selfHealedNoOp, true);

  const skipped = buildExecutionRecord("close the popup if open", { kind: "tapIfExists" }, { success: true, skipped: true });
  assert.strictEqual(skipped.skipped, true);
});

setImmediate(() => {
  if (process.exitCode) {
    console.error("\ngeneration/execution-log tests FAILED");
    process.exit(1);
  } else {
    console.log("\ngeneration/execution-log tests passed");
  }
});
