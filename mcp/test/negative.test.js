// Negative tests for the MCP server: unknown tools, missing or wrongly typed arguments, path-like ids and an unreachable Phoenix are answered with an error result, never a throw.
const assert = require("assert");
const server = require("../server");
let failed = 0; async function test(n, f) { try { await f(); console.log(`  ok - ${n}`); } catch (e) { failed += 1; console.log(`  FAIL - ${n}\n    ${e.stack}`); } }
(async () => {
  server._setFetch(async () => { throw new Error("connect ECONNREFUSED"); });
  await test("an unknown tool is an error result", async () => {
    for (const n of ["", "nope", "__proto__", "../../etc/passwd", "run_test_case; rm -rf /", null, undefined, 5]) { const r = await server.handleToolCall(n, {}); assert.ok(r && r.isError, String(n)); }
  });
  await test("every tool survives missing, null and wrongly typed arguments", async () => {
    for (const t of server.TOOLS) for (const args of [undefined, null, {}, { name: 5 }, { name: ["x"] }, { id: {} }, { path: "../../etc/passwd" }, { name: "x".repeat(100000) }, { caseId: "../../../etc/passwd" }, { limit: -1 }, { limit: "abc" }]) {
      let r; try { r = await server.handleToolCall(t.name, args === undefined ? undefined : args); } catch (e) { assert.fail(`${t.name}(${JSON.stringify(args)}) threw: ${e.message}`); }
      assert.ok(r && Array.isArray(r.content), `${t.name} -> ${JSON.stringify(r)}`);
    }
  });
  await test("Phoenix being down is said plainly for the agent tools, with no secret in the message", async () => {
    for (const [n, a] of [["list_agents", {}], ["get_agent", { name: "scout" }], ["call_agent", { name: "scout", input: "x" }], ["get_my_avatar", {}]]) {
      const r = await server.handleToolCall(n, a); assert.ok(r.isError, n); assert.ok(!/token|password|secret|authorization/i.test(JSON.stringify(r)), n);
    }
  });
  await test("a path-like test case id cannot read a file outside the test-cases folder", async () => {
    for (const id of ["../../package.json", "..%2f..%2fpackage.json", "/etc/passwd", "a/../../b"]) { const r = await server.handleToolCall("get_test_case", { id, name: id, file: id }); assert.ok(r.isError || !/"name":\s*"testops/i.test(JSON.stringify(r)), id); }
  });
  console.log(failed ? `${failed} FAILED` : "mcp negative tests passed"); process.exit(failed ? 1 : 0);
})();
