/**
 * Tests for mcp/server.js -- call handleToolCall() directly (the same
 * function the real MCP transport dispatches into) rather than driving
 * a real stdio client/server pair, since the logic under test is the
 * tool implementations themselves, not the SDK's own transport code.
 *
 * Run with: node test/server.test.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

async function run(name, fn) {
  try {
    await fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function parse(result) {
  assert.ok(!result.isError, `expected a non-error result, got: ${JSON.stringify(result)}`);
  return JSON.parse(result.content[0].text);
}

(async () => {
  // Isolate every test behind its own tmp DB/log/test-cases dir so
  // nothing here touches the real repo's actual locator-store.db or
  // training-data/executions.jsonl.
  const tmpDbPath = path.join(os.tmpdir(), `testops-mobile-mcp-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "testops-mobile-mcp-log-"));
  process.env.TESTOPS_MOBILE_LOCATOR_DB_PATH = tmpDbPath;
  process.env.TESTOPS_MOBILE_TRAINING_LOG_PATH = path.join(tmpLogDir, "executions.jsonl");

  const { handleToolCall, TOOLS, summarizeHealth } = require("../server");
  const { openLocatorStore, recordResolution } = require("../../engine/locator-store");
  const { logExecution } = require("../../generation/execution-log");

  await run("TOOLS lists all five read-only tools plus run_test_case", () => {
    const names = TOOLS.map((t) => t.name).sort();
    assert.deepStrictEqual(names, [
      "get_locator_history",
      "get_recent_executions",
      "get_suite_health",
      "get_test_case",
      "list_test_cases",
      "run_test_case",
    ]);
  });

  await run("get_locator_history returns rows for a test case", async () => {
    const store = openLocatorStore(tmpDbPath);
    recordResolution(store, { testCaseFile: "addons.ios.json", stepIndex: 0, instruction: "tap Allow", selector: { strategy: "accessibility-id", value: "Allow" }, verified: true });
    store.close();

    const result = await handleToolCall("get_locator_history", { testCaseFile: "addons.ios.json" });
    const rows = parse(result);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].instruction, "tap Allow");
  });

  await run("get_locator_history narrows to one stepIndex when given", async () => {
    const store = openLocatorStore(tmpDbPath);
    recordResolution(store, { testCaseFile: "multi.json", stepIndex: 0, instruction: "a", selector: { strategy: "accessibility-id", value: "A" }, verified: true });
    recordResolution(store, { testCaseFile: "multi.json", stepIndex: 1, instruction: "b", selector: { strategy: "accessibility-id", value: "B" }, verified: true });
    store.close();

    const result = await handleToolCall("get_locator_history", { testCaseFile: "multi.json", stepIndex: 1 });
    const rows = parse(result);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].step_index, 1);
  });

  await run("get_suite_health summarizes verified/unverified/drift across one test case", async () => {
    const store = openLocatorStore(tmpDbPath);
    recordResolution(store, { testCaseFile: "health.json", stepIndex: 0, instruction: "a", selector: { strategy: "accessibility-id", value: "A" }, verified: true });
    recordResolution(store, { testCaseFile: "health.json", stepIndex: 1, instruction: "b", selector: { strategy: "accessibility-id", value: "B" }, verified: false });
    recordResolution(store, { testCaseFile: "health.json", stepIndex: 1, instruction: "b", selector: { strategy: "accessibility-id", value: "B2" }, verified: true }); // drift
    store.close();

    const result = await handleToolCall("get_suite_health", { testCaseFile: "health.json" });
    const health = parse(result);
    assert.strictEqual(health.totalSteps, 2);
    assert.strictEqual(health.everVerified, 2);
    assert.strictEqual(health.everDrifted, 1);
    assert.strictEqual(health.topDrift[0].stepIndex, 1);
  });

  await run("summarizeHealth: a step with zero verified_hits counts as neverVerified", () => {
    const health = summarizeHealth([
      { test_case: "x", step_index: 0, instruction: "i", verified_hits: 0, unverified_hits: 2, misses: 0 },
    ]);
    assert.strictEqual(health.neverVerified, 1);
    assert.strictEqual(health.everVerified, 0);
  });

  await run("list_test_cases lists the real test-cases/ directory with step counts", async () => {
    const result = await handleToolCall("list_test_cases", {});
    const files = parse(result);
    assert.ok(Array.isArray(files) && files.length > 0);
    const loginEntry = files.find((f) => f.file === "login.json");
    assert.ok(loginEntry, "login.json should be listed");
    assert.ok(typeof loginEntry.stepCount === "number" && loginEntry.stepCount > 0);
  });

  await run("get_test_case returns a real test case's steps", async () => {
    const result = await handleToolCall("get_test_case", { testCaseFile: "login.json" });
    const data = parse(result);
    assert.strictEqual(data.file, "login.json");
    assert.ok(Array.isArray(data.steps) && data.steps.length > 0);
  });

  await run("get_test_case errors cleanly (not a throw) for a file that doesn't exist", async () => {
    const result = await handleToolCall("get_test_case", { testCaseFile: "does-not-exist.json" });
    assert.ok(result.isError);
  });

  await run("get_test_case never path-escapes outside test-cases/ (path.basename strips traversal)", async () => {
    const result = await handleToolCall("get_test_case", { testCaseFile: "../../etc/passwd" });
    // basename("../../etc/passwd") === "passwd", which won't exist under test-cases/
    assert.ok(result.isError);
  });

  await run("get_recent_executions returns logged records, newest first", async () => {
    logExecution({ instruction: "tap A", kind: "tap", success: true, diffSummary: "ok" });
    logExecution({ instruction: "tap B", kind: "tap", success: false, reason: "declined" });
    const result = await handleToolCall("get_recent_executions", { limit: 10 });
    const records = parse(result);
    assert.ok(records.length >= 2);
    assert.strictEqual(records[0].instruction, "tap B"); // most recent first
  });

  await run("get_recent_executions never includes a typed text/secret value (log itself never stores it)", async () => {
    const result = await handleToolCall("get_recent_executions", { limit: 10 });
    const records = parse(result);
    for (const r of records) {
      assert.strictEqual(r.text, undefined);
    }
  });

  await run("run_test_case refuses without confirm:true, even if TESTOPS_MOBILE_MCP_ALLOW_RUN=1", async () => {
    const original = process.env.TESTOPS_MOBILE_MCP_ALLOW_RUN;
    process.env.TESTOPS_MOBILE_MCP_ALLOW_RUN = "1";
    try {
      const result = await handleToolCall("run_test_case", { platform: "ios", testCaseFile: "test-cases/addons.ios.json", confirm: false });
      assert.ok(result.isError);
      assert.ok(result.content[0].text.includes("confirm"));
    } finally {
      if (original === undefined) delete process.env.TESTOPS_MOBILE_MCP_ALLOW_RUN;
      else process.env.TESTOPS_MOBILE_MCP_ALLOW_RUN = original;
    }
  });

  await run("run_test_case refuses when the server wasn't started with TESTOPS_MOBILE_MCP_ALLOW_RUN=1, even with confirm:true", async () => {
    const original = process.env.TESTOPS_MOBILE_MCP_ALLOW_RUN;
    delete process.env.TESTOPS_MOBILE_MCP_ALLOW_RUN;
    try {
      const result = await handleToolCall("run_test_case", { platform: "ios", testCaseFile: "test-cases/addons.ios.json", confirm: true });
      assert.ok(result.isError);
      assert.ok(result.content[0].text.includes("TESTOPS_MOBILE_MCP_ALLOW_RUN"));
    } finally {
      if (original === undefined) delete process.env.TESTOPS_MOBILE_MCP_ALLOW_RUN;
      else process.env.TESTOPS_MOBILE_MCP_ALLOW_RUN = original;
    }
  });

  await run("run_test_case never accepts/forwards a credential argument (no such field exists on the tool schema)", () => {
    const schema = TOOLS.find((t) => t.name === "run_test_case").inputSchema;
    const propNames = Object.keys(schema.properties);
    for (const name of propNames) {
      assert.ok(!/password|key|secret|token/i.test(name), `run_test_case schema must never accept a credential-shaped field, found "${name}"`);
    }
  });

  await run("unknown tool name returns a clean error, not a throw", async () => {
    const result = await handleToolCall("not_a_real_tool", {});
    assert.ok(result.isError);
  });
})();
