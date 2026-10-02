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

const { logExecution, buildExecutionRecord, logPath, getDeadSelectors, getExpectFailedSelectors, pruneOldExecutions, retentionDays } = require("../execution-log");

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

test("buildExecutionRecord captures deadSelector (the pre-heal dead end) separately from selector (the post-heal working one)", () => {
  const healed = buildExecutionRecord(
    "tap the Add-ons card",
    { kind: "tap" },
    {
      success: true,
      selfHealedNoOp: true,
      selector: { strategy: "resource-id", value: "working_button" },
      deadSelector: { strategy: "resource-id", value: "dead_button" },
    }
  );
  assert.deepStrictEqual(healed.selector, { strategy: "resource-id", value: "working_button" });
  assert.deepStrictEqual(healed.deadSelector, { strategy: "resource-id", value: "dead_button" });

  const notHealed = buildExecutionRecord("tap the LOGIN button", { kind: "tap" }, { success: true, selector: { strategy: "resource-id", value: "login_button" } });
  assert.strictEqual(notHealed.deadSelector, undefined, "a normal (never-healed) result has no deadSelector to report");
});

test("getDeadSelectors returns a final (never-healed) \"No visible change.\" result's own selector as the dead end", () => {
  logExecution({
    instruction: "tap the Add-ons card",
    kind: "tap",
    success: true,
    diffSummary: "No visible change.",
    selector: { strategy: "resource-id", value: "dead_button" },
  });
  const dead = getDeadSelectors("tap the Add-ons card");
  assert.deepStrictEqual(dead, [{ strategy: "resource-id", value: "dead_button" }]);
});

test("getDeadSelectors returns a healed result's deadSelector, not its (working) selector", () => {
  logExecution({
    instruction: "tap the Add-ons card 2",
    kind: "tap",
    success: true,
    selfHealedNoOp: true,
    selector: { strategy: "resource-id", value: "working_button" },
    deadSelector: { strategy: "resource-id", value: "dead_button" },
  });
  const dead = getDeadSelectors("tap the Add-ons card 2");
  assert.deepStrictEqual(dead, [{ strategy: "resource-id", value: "dead_button" }]);
});

test("getDeadSelectors never includes a successful, non-healed result's selector (it's a real, working match, not a dead end)", () => {
  logExecution({
    instruction: "tap the Add-ons card 3",
    kind: "tap",
    success: true,
    diffSummary: "Appeared: \"Add-On\".",
    selector: { strategy: "resource-id", value: "working_button" },
  });
  const dead = getDeadSelectors("tap the Add-ons card 3");
  assert.deepStrictEqual(dead, []);
});

test("getDeadSelectors scopes to kind \"tap\" and the exact instruction string only", () => {
  logExecution({
    instruction: "tap the Add-ons card 4",
    kind: "type", // not a tap -- must never be treated as a dead tap
    success: true,
    diffSummary: "No visible change.",
    selector: { strategy: "resource-id", value: "not_actually_dead" },
  });
  logExecution({
    instruction: "a completely different instruction",
    kind: "tap",
    success: true,
    diffSummary: "No visible change.",
    selector: { strategy: "resource-id", value: "also_not_relevant" },
  });
  assert.deepStrictEqual(getDeadSelectors("tap the Add-ons card 4"), []);
});

test("getDeadSelectors dedups repeated dead selectors and respects limit, most recent first", () => {
  for (let i = 0; i < 3; i += 1) {
    logExecution({
      instruction: "tap the flaky card",
      kind: "tap",
      success: true,
      diffSummary: "No visible change.",
      selector: { strategy: "resource-id", value: "same_dead_button" },
    });
  }
  logExecution({
    instruction: "tap the flaky card",
    kind: "tap",
    success: true,
    diffSummary: "No visible change.",
    selector: { strategy: "accessibility-id", value: "second_dead_control" },
  });
  const dead = getDeadSelectors("tap the flaky card");
  assert.strictEqual(dead.length, 2, "repeated identical dead selectors should be deduped to one entry");
  assert.deepStrictEqual(dead, [
    { strategy: "accessibility-id", value: "second_dead_control" }, // most recent
    { strategy: "resource-id", value: "same_dead_button" },
  ]);

  const limited = getDeadSelectors("tap the flaky card", { limit: 1 });
  assert.strictEqual(limited.length, 1);
  assert.deepStrictEqual(limited[0], { strategy: "accessibility-id", value: "second_dead_control" });
});

test("getDeadSelectors returns [] when there's no log file yet, and tolerates a corrupt line", () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-exec-log-empty-"));
  const originalPath = process.env.PHOENIX_TRAINING_LOG_PATH;
  process.env.PHOENIX_TRAINING_LOG_PATH = path.join(emptyDir, "executions.jsonl");
  try {
    assert.deepStrictEqual(getDeadSelectors("tap anything"), []);

    fs.writeFileSync(process.env.PHOENIX_TRAINING_LOG_PATH, "not valid json\n" + JSON.stringify({
      instruction: "tap anything",
      kind: "tap",
      success: true,
      diffSummary: "No visible change.",
      selector: { strategy: "resource-id", value: "survives_the_corrupt_line" },
    }) + "\n");
    assert.deepStrictEqual(getDeadSelectors("tap anything"), [{ strategy: "resource-id", value: "survives_the_corrupt_line" }]);
  } finally {
    process.env.PHOENIX_TRAINING_LOG_PATH = originalPath;
  }
});

test("getExpectFailedSelectors returns a real-diff tap's own selector when its step was logged with expectFailed: true", () => {
  logExecution({
    instruction: "tap the Profile tab",
    kind: "tap",
    success: true,
    diffSummary: "Appeared: \"Add-On Details\".",
    selector: { strategy: "resource-id", value: "wrong_but_real_button" },
    expectFailed: true,
  });
  const failed = getExpectFailedSelectors("tap the Profile tab");
  assert.deepStrictEqual(failed, [{ strategy: "resource-id", value: "wrong_but_real_button" }]);
});

test("getExpectFailedSelectors ignores a record with no expectFailed flag (an ordinary successful/verified tap)", () => {
  logExecution({
    instruction: "tap the Profile tab 2",
    kind: "tap",
    success: true,
    diffSummary: "Appeared: \"Profile\".",
    selector: { strategy: "resource-id", value: "actually_correct_button" },
  });
  assert.deepStrictEqual(getExpectFailedSelectors("tap the Profile tab 2"), []);
});

test("getExpectFailedSelectors never overlaps with getDeadSelectors (different bug classes, not double-counted)", () => {
  logExecution({
    instruction: "tap the Profile tab 3",
    kind: "tap",
    success: true,
    diffSummary: "No visible change.",
    selector: { strategy: "resource-id", value: "dead_end_button" },
  });
  logExecution({
    instruction: "tap the Profile tab 3",
    kind: "tap",
    success: true,
    diffSummary: "Appeared: \"Add-On Details\".",
    selector: { strategy: "resource-id", value: "wrong_but_real_button_3" },
    expectFailed: true,
  });
  assert.deepStrictEqual(getDeadSelectors("tap the Profile tab 3"), [{ strategy: "resource-id", value: "dead_end_button" }]);
  assert.deepStrictEqual(getExpectFailedSelectors("tap the Profile tab 3"), [{ strategy: "resource-id", value: "wrong_but_real_button_3" }]);
});

test("getExpectFailedSelectors scopes to kind \"tap\" and the exact instruction string only", () => {
  logExecution({
    instruction: "tap the Profile tab 4",
    kind: "type", // not a tap -- must never be treated as an expect-failed candidate
    success: true,
    diffSummary: "Appeared: \"X\".",
    selector: { strategy: "resource-id", value: "not_actually_relevant" },
    expectFailed: true,
  });
  logExecution({
    instruction: "a completely different instruction",
    kind: "tap",
    success: true,
    diffSummary: "Appeared: \"X\".",
    selector: { strategy: "resource-id", value: "also_not_relevant" },
    expectFailed: true,
  });
  assert.deepStrictEqual(getExpectFailedSelectors("tap the Profile tab 4"), []);
});

test("getExpectFailedSelectors dedups repeated selectors and respects limit, most recent first", () => {
  for (let i = 0; i < 3; i += 1) {
    logExecution({
      instruction: "tap the flaky profile tab",
      kind: "tap",
      success: true,
      diffSummary: "Appeared: \"X\".",
      selector: { strategy: "resource-id", value: "same_wrong_button" },
      expectFailed: true,
    });
  }
  logExecution({
    instruction: "tap the flaky profile tab",
    kind: "tap",
    success: true,
    diffSummary: "Appeared: \"Y\".",
    selector: { strategy: "accessibility-id", value: "second_wrong_control" },
    expectFailed: true,
  });
  const failed = getExpectFailedSelectors("tap the flaky profile tab");
  assert.strictEqual(failed.length, 2, "repeated identical expect-failed selectors should be deduped to one entry");
  assert.deepStrictEqual(failed, [
    { strategy: "accessibility-id", value: "second_wrong_control" }, // most recent
    { strategy: "resource-id", value: "same_wrong_button" },
  ]);

  const limited = getExpectFailedSelectors("tap the flaky profile tab", { limit: 1 });
  assert.strictEqual(limited.length, 1);
  assert.deepStrictEqual(limited[0], { strategy: "accessibility-id", value: "second_wrong_control" });
});

test("getExpectFailedSelectors returns [] when there's no log file yet, and tolerates a corrupt line", () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-exec-log-empty-2-"));
  const originalPath = process.env.PHOENIX_TRAINING_LOG_PATH;
  process.env.PHOENIX_TRAINING_LOG_PATH = path.join(emptyDir, "executions.jsonl");
  try {
    assert.deepStrictEqual(getExpectFailedSelectors("tap anything"), []);

    fs.writeFileSync(process.env.PHOENIX_TRAINING_LOG_PATH, "not valid json\n" + JSON.stringify({
      instruction: "tap anything",
      kind: "tap",
      success: true,
      diffSummary: "Appeared: \"X\".",
      selector: { strategy: "resource-id", value: "survives_the_corrupt_line" },
      expectFailed: true,
    }) + "\n");
    assert.deepStrictEqual(getExpectFailedSelectors("tap anything"), [{ strategy: "resource-id", value: "survives_the_corrupt_line" }]);
  } finally {
    process.env.PHOENIX_TRAINING_LOG_PATH = originalPath;
  }
});

test("retentionDays() defaults to 15 and honors PHOENIX_TRAINING_LOG_RETENTION_DAYS", () => {
  const original = process.env.PHOENIX_TRAINING_LOG_RETENTION_DAYS;
  try {
    delete process.env.PHOENIX_TRAINING_LOG_RETENTION_DAYS;
    assert.strictEqual(retentionDays(), 15);
    process.env.PHOENIX_TRAINING_LOG_RETENTION_DAYS = "30";
    assert.strictEqual(retentionDays(), 30);
    // Garbage/non-positive values fall back to the default rather than
    // silently disabling cleanup or pruning everything.
    process.env.PHOENIX_TRAINING_LOG_RETENTION_DAYS = "not-a-number";
    assert.strictEqual(retentionDays(), 15);
    process.env.PHOENIX_TRAINING_LOG_RETENTION_DAYS = "-5";
    assert.strictEqual(retentionDays(), 15);
  } finally {
    if (original === undefined) delete process.env.PHOENIX_TRAINING_LOG_RETENTION_DAYS;
    else process.env.PHOENIX_TRAINING_LOG_RETENTION_DAYS = original;
  }
});

test("pruneOldExecutions removes records past the retention window and keeps recent ones", () => {
  const prunePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-exec-log-prune-")), "executions.jsonl");
  const original = process.env.PHOENIX_TRAINING_LOG_PATH;
  process.env.PHOENIX_TRAINING_LOG_PATH = prunePath;
  try {
    const now = Date.now();
    const old = new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString(); // 20 days ago
    const recent = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
    fs.mkdirSync(path.dirname(prunePath), { recursive: true });
    fs.writeFileSync(
      prunePath,
      [
        JSON.stringify({ instruction: "old one", loggedAt: old }),
        JSON.stringify({ instruction: "recent one", loggedAt: recent }),
        "{ this is not valid json",
      ].join("\n") + "\n"
    );

    const result = pruneOldExecutions();
    assert.deepStrictEqual(result, { kept: 1, removed: 2 });

    const remaining = fs.readFileSync(prunePath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].instruction, "recent one");
  } finally {
    process.env.PHOENIX_TRAINING_LOG_PATH = original;
  }
});

test("pruneOldExecutions keeps a record with no parseable loggedAt rather than guessing it's stale", () => {
  const prunePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-exec-log-prune-noage-")), "executions.jsonl");
  const original = process.env.PHOENIX_TRAINING_LOG_PATH;
  process.env.PHOENIX_TRAINING_LOG_PATH = prunePath;
  try {
    fs.mkdirSync(path.dirname(prunePath), { recursive: true });
    fs.writeFileSync(prunePath, JSON.stringify({ instruction: "no timestamp" }) + "\n");
    const result = pruneOldExecutions();
    assert.deepStrictEqual(result, { kept: 1, removed: 0 });
  } finally {
    process.env.PHOENIX_TRAINING_LOG_PATH = original;
  }
});

test("pruneOldExecutions returns undefined (not an error) when there's no log file yet", () => {
  const prunePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-exec-log-prune-missing-")), "executions.jsonl");
  const original = process.env.PHOENIX_TRAINING_LOG_PATH;
  process.env.PHOENIX_TRAINING_LOG_PATH = prunePath;
  try {
    assert.strictEqual(pruneOldExecutions(), undefined);
  } finally {
    process.env.PHOENIX_TRAINING_LOG_PATH = original;
  }
});

test("logExecution automatically triggers cleanup once the retention window has elapsed, with no separate scheduling step", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-exec-log-auto-prune-"));
  const autoPrunePath = path.join(dir, "executions.jsonl");
  const sentinelPath = `${autoPrunePath}.last-prune`;
  const originalPath = process.env.PHOENIX_TRAINING_LOG_PATH;
  const originalRetention = process.env.PHOENIX_TRAINING_LOG_RETENTION_DAYS;
  process.env.PHOENIX_TRAINING_LOG_PATH = autoPrunePath;
  process.env.PHOENIX_TRAINING_LOG_RETENTION_DAYS = "15";
  try {
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(autoPrunePath, JSON.stringify({ instruction: "stale", loggedAt: old }) + "\n");
    // Backdate the sentinel past the retention window so the next log
    // call treats a cleanup as due -- simulates "15 days have passed"
    // without actually waiting 15 days in a test.
    fs.writeFileSync(sentinelPath, new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString());

    logExecution({ instruction: "fresh one" });

    const remaining = fs.readFileSync(autoPrunePath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.strictEqual(remaining.length, 1, "the stale pre-existing record should have been pruned automatically");
    assert.strictEqual(remaining[0].instruction, "fresh one");

    // The sentinel itself should have been refreshed so cleanup doesn't
    // re-run on every single call going forward.
    const sentinelAfter = Date.parse(fs.readFileSync(sentinelPath, "utf8").trim());
    assert.ok(Date.now() - sentinelAfter < 5000, "sentinel should be refreshed to roughly now");
  } finally {
    process.env.PHOENIX_TRAINING_LOG_PATH = originalPath;
    if (originalRetention === undefined) delete process.env.PHOENIX_TRAINING_LOG_RETENTION_DAYS;
    else process.env.PHOENIX_TRAINING_LOG_RETENTION_DAYS = originalRetention;
  }
});

test("logExecution does NOT re-prune on every call once the sentinel is fresh (avoids rewriting the log on every single execution)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-exec-log-no-reprune-"));
  const freshPrunePath = path.join(dir, "executions.jsonl");
  const sentinelPath = `${freshPrunePath}.last-prune`;
  const originalPath = process.env.PHOENIX_TRAINING_LOG_PATH;
  process.env.PHOENIX_TRAINING_LOG_PATH = freshPrunePath;
  try {
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(freshPrunePath, JSON.stringify({ instruction: "stale but protected by a fresh sentinel", loggedAt: old }) + "\n");
    fs.writeFileSync(sentinelPath, new Date().toISOString()); // "just pruned a moment ago"

    logExecution({ instruction: "another one" });

    const remaining = fs.readFileSync(freshPrunePath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    // The old record survives because cleanup wasn't due yet -- only
    // the new append happened.
    assert.ok(remaining.some((r) => r.instruction === "stale but protected by a fresh sentinel"));
    assert.ok(remaining.some((r) => r.instruction === "another one"));
  } finally {
    process.env.PHOENIX_TRAINING_LOG_PATH = originalPath;
  }
});

setImmediate(() => {
  if (process.exitCode) {
    console.error("\ngeneration/execution-log tests FAILED");
    process.exit(1);
  } else {
    console.log("\ngeneration/execution-log tests passed");
  }
});
