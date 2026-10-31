/** Starts the real server on a free port with throw-away data dirs and runs scripts/validate-server.js against it. */
const assert = require("assert");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net");
const root = path.join(__dirname, "..", "..");
const free = () => new Promise((ok) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
(async () => {
  const port = await free(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-"));
  const env = { ...process.env, TESTOPS_MOBILE_FRONTEND_PORT: String(port), TESTOPS_GATEWAY_DIR: path.join(tmp, "lib"), TESTOPS_GATEWAY_LOG: path.join(tmp, "g.jsonl"), TESTOPS_PIPELINE_LOG: path.join(tmp, "p.jsonl"), TESTOPS_RUNS_DIR: path.join(tmp, "runs"), TESTOPS_TESTDATA_DIR: path.join(tmp, "td"), ZAP_API_URL: "http://127.0.0.1:1", TESTOPS_MOBILE_LIVE_VIEW_PORT: String(await free()) };
  const server = spawn("node", ["frontend/server.js"], { cwd: root, env, stdio: "ignore" });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://localhost:${port}/`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
    const r = spawnSync("node", ["scripts/validate-server.js", `http://localhost:${port}`], { cwd: root, encoding: "utf8", env, timeout: 170000 });
    console.log(r.stdout.split("\n").filter((l) => /passed,|FAIL/.test(l)).join("\n"));
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    for (const must of ["Pages", "Tools", "Gateway", "Pipeline stage", "Test data", "API testing", "Run targets"]) assert.ok(r.stdout.includes(must), "missing group " + must);
    assert.ok(!/FAIL/.test(r.stdout));
    console.log("validate-server tests passed");
  } finally { server.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
