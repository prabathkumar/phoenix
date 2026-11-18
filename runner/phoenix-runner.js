#!/usr/bin/env node
/**
 * Phoenix laptop runner. Lets Phoenix (TestOps in AWS) use a browser on THIS computer, so intranet and VPN apps can be tested.
 *
 *   node runner/phoenix-runner.js pair  https://phoenix.example.com  ABCD-EFGH     one time: code from Phoenix > Runners
 *   node runner/phoenix-runner.js start                                              keep running while you want Phoenix to use this computer
 *   node runner/phoenix-runner.js forget                                             delete the saved pairing
 *
 * It only ever connects OUT to Phoenix (wss, port 443). Nothing listens on the network: the live view it opens is bound to 127.0.0.1.
 * It opens only the addresses the pairing allows (and never cloud-metadata ranges). Passwords typed into a live session stay here; Phoenix never receives them in steps.
 */
const fs = require("fs"); const os = require("os"); const path = require("path");
const { allowed, urlsInSteps } = require("./allowlist");
const CONF = process.env.PHOENIX_RUNNER_CONFIG || path.join(os.homedir(), ".phoenix-runner.json");
const web = (p) => path.join(__dirname, "..", "web", p);
const WS = require(require.resolve("ws", { paths: [path.join(__dirname, "..", "web")] }));

const load = () => { try { return JSON.parse(fs.readFileSync(CONF, "utf8")); } catch { return null; } };
const save = (c) => { fs.writeFileSync(CONF, JSON.stringify(c, null, 1), { mode: 0o600 }); fs.chmodSync(CONF, 0o600); };
const wsUrl = (server) => server.replace(/^http/, "ws").replace(/\/$/, "") + "/api/runners/connect";

async function pair(server, code) {
  if (!/^https:\/\//.test(server) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(server)) throw new Error("the Phoenix address must be https://");
  const res = await fetch(server.replace(/\/$/, "") + "/api/runners/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: os.hostname(), os: `${os.platform()} ${os.release()}` }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.detail || `pairing refused (${res.status})`);
  save({ server, runnerId: j.runnerId, token: j.token, allow: j.allow });
  console.log(`Paired as ${j.runnerId}. It may open: ${j.allow.join(", ")}\nNow run: node runner/phoenix-runner.js start`);
}

function start(opts = {}) {
  const conf = opts.conf || load();
  if (!conf) throw new Error("not paired: run `pair` first");
  const log = opts.log || ((m) => console.log(new Date().toISOString().slice(11, 19), m));
  const live = new Map();          // job id -> {close, local ws}
  let busy = false, sock, stopped = false, beat;
  const out = (m) => { if (sock && sock.readyState === 1) sock.send(JSON.stringify(m)); };

  async function runCase(job) {
    const bad = urlsInSteps(job.steps, job.baseUrl).find((u) => !allowed(u, conf.allow));
    if (bad) return { success: false, status: "refused", detail: `the runner will not open ${new URL(bad).hostname}: it is not in this runner's allowed list` };
    const { runWebTestCase } = (opts.web && opts.web.runner) || require(web("web-test-case-runner"));
    return runWebTestCase(job.steps, { baseUrl: job.baseUrl, headless: job.headed === false, testCase: job.name || "laptop run", runOn: "local", contextOptions: {}, testData: job.testData, ranOn: { where: `laptop ${os.hostname()}` } });
  }

  async function startLive(job) {
    if (!allowed(job.url, conf.allow)) return out({ type: "live-closed", id: job.id, reason: `the runner will not open that address (not in its allowed list)` });
    const { startWebLiveView } = (opts.web && opts.web.live) || require(web("recorder/web-live-view"));
    const v = await startWebLiveView({ port: 0, host: "127.0.0.1", startUrl: job.url, name: job.name || "laptop session", headless: false, runOn: "local" });
    const port = v.wss.address().port;
    // a click inside the page must not leave the allowed list either
    try { await v.page.context().route("**/*", (route) => { const r = route.request(); (r.isNavigationRequest() && r.frame() === v.page.mainFrame() && !allowed(r.url(), conf.allow)) ? route.abort() : route.continue(); }); } catch { /* best effort */ }
    const local = new WS(`ws://127.0.0.1:${port}`);
    local.on("message", (d) => out({ type: "live-out", id: job.id, data: String(d) }));
    local.on("close", () => { live.delete(job.id); out({ type: "live-closed", id: job.id, reason: "session ended" }); try { v.close(); } catch { /* done */ } busy = false; });
    live.set(job.id, { local, close: () => { try { local.close(); } catch { /* gone */ } try { v.close(); } catch { /* gone */ } } });
  }

  function connect() {
    sock = new WS(opts.url || wsUrl(conf.server), { headers: { Authorization: `Bearer ${conf.token}` } });
    sock.on("open", () => { log(`connected to ${conf.server}`); out({ type: "hello", os: `${os.platform()}`, busy }); beat = setInterval(() => out({ type: "ping", busy }), 20000); });
    sock.on("message", async (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === "job") {
        if (busy) return out({ type: "job-result", id: m.id, result: { success: false, status: "busy", detail: "this runner is already running a job" } });
        busy = true;
        try {
          if (m.kind === "live") { log(`live session ${m.id}`); await startLive(m); }
          else { log(`test case ${m.id}`); const result = await runCase(m); out({ type: "job-result", id: m.id, result }); busy = false; }
        } catch (e) { out({ type: "job-result", id: m.id, result: { success: false, status: "error", detail: String(e.message || e).slice(0, 300) } }); busy = false; }
      } else if (m.type === "live-in") { const l = live.get(m.id); if (l && l.local.readyState === 1) l.local.send(m.data); }
      else if (m.type === "live-stop") { const l = live.get(m.id); if (l) l.close(); }
      else if (m.type === "revoked") { log("this pairing was revoked in Phoenix; stopping"); stopped = true; sock.close(); }
    });
    sock.on("close", (code) => { clearInterval(beat); if (stopped || opts.once) return; log(`disconnected (${code}); retrying in 10s`); setTimeout(connect, 10000); });
    sock.on("error", (e) => log(`connection problem: ${e.message}`));
  }
  connect();
  return { stop() { stopped = true; clearInterval(beat); live.forEach((l) => l.close()); try { sock.close(); } catch { /* closed */ } } };
}

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  (async () => {
    if (cmd === "pair" && a && b) await pair(a, b);
    else if (cmd === "start") start();
    else if (cmd === "forget") { try { fs.unlinkSync(CONF); console.log("pairing removed from this computer (also revoke it in Phoenix > Runners)"); } catch { console.log("nothing to remove"); } }
    else console.log("usage: phoenix-runner.js pair <https://phoenix-address> <code> | start | forget");
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
module.exports = { start, pair };
