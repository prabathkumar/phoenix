const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
const H = require("../core/handlers");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "h-"));
(async () => {
  // scenarios/cases: model + registry prompt; nothing usable is a failure, no model is "unavailable".
  const gp = (n) => ({ text: `PROMPT ${n}`, id: `${n}:shared:v1:abc` });
  const seen = [];
  const cj = async (p) => { seen.push(p); return { scenarios: [{ title: "a" }, { title: "b" }] }; };
  let r = await H.scenariosHandler({ callJson: cj, getPrompt: gp })({ requirement: "login page" });
  assert.strictEqual(r.ok, true); assert.ok(/2 from scenario_batch/.test(r.detail)); assert.ok(seen[0].includes("login page"));
  r = await H.casesHandler({ callJson: cj, getPrompt: gp })({ requirement: "x", results: [{ id: "scenarios", data: r.data }] });
  assert.ok(seen[1].includes('"title":"a"'));
  assert.strictEqual((await H.scenariosHandler({ callJson: async () => ({}), getPrompt: gp })({})).ok, false);
  assert.strictEqual((await H.scenariosHandler({ getPrompt: gp })({})).unavailable, true);

  // HAR: reads what the run recorded.
  const d = tmp(), har = path.join(d, "a.har");
  fs.writeFileSync(har, JSON.stringify({ log: { entries: [{ time: 50, request: { url: "https://x/a?q=1" }, response: { status: 200 } }, { time: 900, request: { url: "https://x/b" }, response: { status: 500 } }] } }));
  r = await H.harHandler()({ harPath: har });
  assert.ok(r.ok && /2 requests, 1 with status 400/.test(r.detail) && /900ms https:\/\/x\/b/.test(r.detail));
  assert.strictEqual((await H.harHandler()({})).unavailable, true);
  assert.deepStrictEqual(H.harContextOptions("p.har"), { recordHar: { path: "p.har", mode: "minimal" } });

  // Locust file from API steps; run through a fake exec that writes the stats.
  const steps = [{ kind: "api", method: "POST", url: "https://h/api/login", body: { u: "a" } }, { kind: "api", method: "GET", url: "/api/me" }, { kind: "tap" }];
  const code = H.locustFile(steps, "https://h");
  assert.ok(code.includes('self.client.post("/api/login", json={"u":"a"})') && code.includes('self.client.get("/api/me")'));
  assert.strictEqual(H.locustFile([{ kind: "tap" }], "x"), null);
  const pd = tmp();
  const exec = (cmd, args) => { if (args[0] === "--version") return { status: 0 }; fs.writeFileSync(path.join(pd, "run_stats.csv"), "Type,Name,Request Count,Failure Count\n,Aggregated,200,4\n"); return { status: 0 }; };
  r = await H.performanceHandler({ exec, dir: pd })({ steps, baseUrl: "https://h" });
  assert.ok(/200 requests, 4 failed \(2.0%\)/.test(r.detail));
  assert.strictEqual(r.ok, false); // 2% is over the 1% limit
  assert.strictEqual((await H.performanceHandler({ exec: () => ({ status: 127 }), dir: pd })({ steps, baseUrl: "https://h" })).unavailable, true);
  assert.strictEqual((await H.performanceHandler({ exec, dir: pd })({ steps })).unavailable, true);

  // HAR -> Locust: same host only, no assets, duplicates dropped.
  const lh = H.locustFromHar({ log: { entries: [
    { request: { method: "GET", url: "https://h/api/a?x=1" } }, { request: { method: "GET", url: "https://h/api/a?x=1" } },
    { request: { method: "POST", url: "https://h/api/b", postData: { text: '{"k":1}' } } },
    { request: { method: "GET", url: "https://h/logo.png" } }, { request: { method: "GET", url: "https://cdn.other/x" } }] } }, "https://h");
  assert.ok(lh.includes('"/api/a?x=1"') && lh.includes('json={"k":1}') && !lh.includes("logo.png") && !lh.includes("other") && lh.split("@task").length === 3);
  const pdh = tmp(); fs.writeFileSync(path.join(pdh, "h.har"), JSON.stringify({ log: { entries: [{ request: { method: "GET", url: "https://h/api/a" } }] } }));
  const pexec = (c, a) => { if (a[0] === "--version") return { status: 0 }; fs.writeFileSync(path.join(pdh, "run_stats.csv"), "T,N,R,F\n,Agg,100,0\n"); return { status: 0 }; };
  assert.ok((await H.performanceHandler({ exec: pexec, dir: pdh })({ harPath: path.join(pdh, "h.har"), baseUrl: "https://h" })).ok);
  // ZAP: exit codes mapped; docker used when zap is not local.
  const calls = [];
  const zx = (code) => (cmd, args) => { calls.push(cmd); return args[0] === "--version" ? { status: cmd === "docker" ? 0 : 127 } : { status: code }; };
  assert.strictEqual((await H.dastHandler({ exec: zx(0), dir: tmp() })({ appUrl: "https://app" })).ok, true);
  assert.ok(calls.includes("docker"));
  assert.ok(calls.length && true);
  assert.ok(/warnings/.test((await H.dastHandler({ exec: zx(2), dir: tmp() })({ appUrl: "https://app" })).detail));
  assert.strictEqual((await H.dastHandler({ exec: () => ({ status: 127 }), dir: tmp() })({ appUrl: "u" })).unavailable, true);

  // Feedback: a secret-free report.
  const fd = tmp();
  r = await H.feedbackHandler({ dir: fd })({ goal: "g", results: [{ id: "x", status: "passed", detail: "ok", data: { secret: "S3CR3T" } }] });
  assert.ok(r.ok && !fs.readFileSync(path.join(fd, fs.readdirSync(fd)[0]), "utf8").includes("S3CR3T"));
  assert.ok(["scenarios", "cases", "har", "performance", "dast", "feedback"].every((k) => typeof H.allHandlers({})[k] === "function"));
  console.log("handlers tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
