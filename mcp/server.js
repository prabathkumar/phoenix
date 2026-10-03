#!/usr/bin/env node
/**
 * mcp/server.js -- the Phoenix-side MCP connector.
 *
 * What this is: a standard MCP server (stdio transport, the Model
 * Context Protocol's local-process convention) exposing Phoenix's own
 * data -- the locator confidence store, the execution-training log,
 * and the test-case files themselves -- as tools an MCP CLIENT can
 * call. The user's own TestOps product already has its own MCP,
 * headed for the Claude marketplace later; this is NOT that server,
 * and doesn't try to be. This is Phoenix's side of the wire: something
 * TestOps's MCP (or Claude Code, or any other MCP client) can launch
 * as a subprocess and query for data that only Phoenix actually has.
 *
 * Why this doesn't require Ollama (Phoenix's own local resolver model)
 * to support tool-calling: it doesn't touch Ollama at all. MCP here is
 * a completely separate, external-facing channel -- an MCP CLIENT
 * (TestOps, Claude, anything speaking the protocol) calls INTO this
 * server; Phoenix's own internal `generation/llm.js` resolver keeps
 * calling Ollama's plain /api/generate exactly as before, completely
 * decoupled from this file. Two different directions, two different
 * models, zero interaction between them.
 *
 * Read-only tools (get_locator_history, get_suite_health,
 * list_test_cases, get_test_case, get_recent_executions) have no
 * guardrails beyond normal error handling -- they can't cost anything
 * or change anything. run_test_case is the one tool that spends a REAL
 * BrowserStack session and can take real device-minutes -- see its own
 * doc comment below for why it requires an explicit `confirm: true`
 * argument and is opt-in at the server level
 * (PHOENIX_MCP_ALLOW_RUN=1), after this exact engagement's own history
 * of real sessions burned by an unintended run.
 *
 * Run standalone: `node mcp/server.js` (talks stdio, so run it from an
 * MCP client, not interactively in a terminal). Install: `cd mcp && npm install`.
 */

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const REPO_ROOT = path.join(__dirname, "..");
const { openLocatorStore, getLocatorStats, getAllLocatorStats } = require(path.join(REPO_ROOT, "engine", "locator-store"));
const { loadTestCaseSteps } = require(path.join(REPO_ROOT, "engine", "test-case-runner"));
const { getRecentExecutions } = require(path.join(REPO_ROOT, "generation", "execution-log"));

const TEST_CASES_DIR = path.join(REPO_ROOT, "test-cases");

function listTestCaseFiles() {
  if (!fs.existsSync(TEST_CASES_DIR)) return [];
  return fs
    .readdirSync(TEST_CASES_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

/**
 * Summarizes a set of locator rows into the "is this suite healthy"
 * numbers a human/MCP client actually wants: how many steps are
 * tracked, how many have never been confirmed correct, and which
 * ones have drifted most (highest `misses`) -- the concrete answer to
 * the "regression suite rotting" question raised earlier in this
 * engagement, now queryable instead of requiring a log-by-log read.
 */
function summarizeHealth(rows) {
  const totalSteps = rows.length;
  const everVerified = rows.filter((r) => r.verified_hits > 0).length;
  const neverVerified = rows.filter((r) => r.verified_hits === 0).length;
  const everDrifted = rows.filter((r) => r.misses > 0).length;
  const topDrift = [...rows]
    .sort((a, b) => b.misses - a.misses)
    .slice(0, 5)
    .filter((r) => r.misses > 0)
    .map((r) => ({ testCase: r.test_case, stepIndex: r.step_index, instruction: r.instruction, misses: r.misses }));
  return { totalSteps, everVerified, neverVerified, everDrifted, topDrift };
}

/**
 * run_test_case's implementation -- spawns the SAME docker-free local
 * entry point testers already use directly
 * (run-batch-executions.js), passing through only
 * PHOENIX_PLATFORM/PHOENIX_TEST_CASE_FILE/PHOENIX_BATCH_MODES/
 * PHOENIX_BATCH_TOTAL. Deliberately does NOT accept or forward any
 * credential (BrowserStack keys, login phone/password) as a tool
 * argument -- those must already be present in the server process's
 * own environment (its .env/exported vars), exactly like a human
 * running `node run-batch-executions.js` directly would need. This
 * keeps secrets out of the MCP protocol/transcript entirely: an MCP
 * client can trigger a run, but can never see or set a credential
 * through this tool.
 */
function runTestCase({ platform, testCaseFile }) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(REPO_ROOT, "run-batch-executions.js")],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PHOENIX_PLATFORM: platform,
          PHOENIX_TEST_CASE_FILE: testCaseFile,
          PHOENIX_BATCH_MODES: "test-case",
          PHOENIX_BATCH_TOTAL: "1",
        },
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });
    child.on("error", (err) => {
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n[spawn error] ${err.message}` });
    });
  });
}

const TOOLS = [
  {
    name: "get_locator_history",
    description:
      "Returns confidence/history for one test case's locators (verified_hits, unverified_hits, misses, last_verified_at per step), or one specific step if stepIndex is given. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        testCaseFile: { type: "string", description: "e.g. \"addons.ios.json\" -- must match the test_case key used by past runs (usually the path passed as PHOENIX_TEST_CASE_FILE)" },
        stepIndex: { type: "number", description: "Optional: narrow to one step." },
      },
      required: ["testCaseFile"],
    },
  },
  {
    name: "get_suite_health",
    description:
      "Rolls up locator-store data across one test case (or the whole suite if testCaseFile is omitted): how many steps have never been confirmed correct, and which steps have drifted (self-healed) most often. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        testCaseFile: { type: "string", description: "Optional: omit for a suite-wide rollup across every test case this store has ever recorded." },
      },
    },
  },
  {
    name: "list_test_cases",
    description: "Lists the test-case JSON files available under test-cases/, with their step counts. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_test_case",
    description: "Returns one test case's full parsed steps (instructions, kinds, pinned resolvedSelector values). Read-only.",
    inputSchema: {
      type: "object",
      properties: { testCaseFile: { type: "string", description: "File name under test-cases/, e.g. \"addons.ios.json\"." } },
      required: ["testCaseFile"],
    },
  },
  {
    name: "get_recent_executions",
    description:
      "Returns the most recent entries from the execution-training log (training-data/executions.jsonl) -- pass/fail, diffs, dead-tap/expect-failed records. Never includes typed text/secret values (the log itself never stores them). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Default 50." },
        instruction: { type: "string", description: "Optional: filter to one exact instruction string." },
      },
    },
  },
  {
    name: "run_test_case",
    description:
      "DANGER: runs a real test case against a real device session (local Appium or real BrowserStack, per the server's own PHOENIX_APPIUM_PROVIDER) -- this can cost real money/device-minutes on BrowserStack. Disabled unless the server process has PHOENIX_MCP_ALLOW_RUN=1 set, and requires confirm:true on every call regardless. Never pass credentials here -- they must already be configured in the server's own environment.",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["android", "ios"] },
        testCaseFile: { type: "string", description: "Path to the test case, e.g. \"test-cases/addons.ios.json\"." },
        confirm: { type: "boolean", description: "Must be exactly true. A safety interlock, not a default -- this run is not free." },
      },
      required: ["platform", "testCaseFile", "confirm"],
    },
  },
];

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function handleToolCall(name, args = {}) {
  if (name === "get_locator_history") {
    const store = openLocatorStore();
    try {
      const rows = getLocatorStats(store, args.testCaseFile);
      const filtered = typeof args.stepIndex === "number" ? rows.filter((r) => r.step_index === args.stepIndex) : rows;
      return textResult(filtered);
    } finally {
      store.close();
    }
  }

  if (name === "get_suite_health") {
    const store = openLocatorStore();
    try {
      const rows = args.testCaseFile ? getLocatorStats(store, args.testCaseFile) : getAllLocatorStats(store);
      return textResult(summarizeHealth(rows));
    } finally {
      store.close();
    }
  }

  if (name === "list_test_cases") {
    const files = listTestCaseFiles();
    const summaries = files.map((name) => {
      try {
        const steps = loadTestCaseSteps(path.join(TEST_CASES_DIR, name));
        return { file: name, stepCount: steps.length };
      } catch (err) {
        return { file: name, error: err.message };
      }
    });
    return textResult(summaries);
  }

  if (name === "get_test_case") {
    if (!args.testCaseFile) return errorResult("testCaseFile is required");
    const filePath = path.join(TEST_CASES_DIR, path.basename(args.testCaseFile));
    try {
      const steps = loadTestCaseSteps(filePath);
      return textResult({ file: path.basename(filePath), steps });
    } catch (err) {
      return errorResult(`couldn't load "${args.testCaseFile}": ${err.message}`);
    }
  }

  if (name === "get_recent_executions") {
    return textResult(getRecentExecutions({ limit: args.limit, instruction: args.instruction }));
  }

  if (name === "run_test_case") {
    if (args.confirm !== true) {
      return errorResult("Refusing to run: confirm must be exactly true. This spends a real device session.");
    }
    if (process.env.PHOENIX_MCP_ALLOW_RUN !== "1") {
      return errorResult(
        "Refusing to run: this MCP server was started without PHOENIX_MCP_ALLOW_RUN=1. " +
          "An operator must explicitly opt this server into running real test cases before any client can trigger one."
      );
    }
    if (!args.platform || !args.testCaseFile) {
      return errorResult("platform and testCaseFile are both required");
    }
    const result = await runTestCase({ platform: args.platform, testCaseFile: args.testCaseFile });
    return textResult(result);
  }

  return errorResult(`unknown tool "${name}"`);
}

function createServer() {
  const server = new Server(
    { name: "phoenix-mcp", version: "0.0.1" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await handleToolCall(request.params.name, request.params.arguments || {});
    } catch (err) {
      return errorResult(`internal error: ${err.message}`);
    }
  });

  return server;
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[phoenix-mcp] fatal error:", err);
    process.exit(1);
  });
}

module.exports = { createServer, handleToolCall, TOOLS, summarizeHealth, listTestCaseFiles };
