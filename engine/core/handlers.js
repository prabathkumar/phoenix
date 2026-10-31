/**
 * The pipeline's stage handlers, in one place: what Phoenix now does itself.
 *   scenarios, cases  the model + the prompt registry (prompts/prompts.yaml)
 *   har               reads the HAR the web run recorded (contextOptions: harContextOptions(path))
 *   performance       writes a Locust file from the API steps and runs it headless
 *   dast              ZAP baseline scan of a running app (always waits for approval; see pipeline.js)
 *   feedback          saves a secret-free report per run for the AI to read next time
 * Every handler says `unavailable` plainly when its tool or model is missing; none pretends to pass.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 900000, ...opts });
const has = (cmd, exec = run) => { try { return exec(cmd, ["--version"]).status === 0; } catch { return false; } };

// ---- scenarios and cases (AI)
function aiHandler(promptName, { callJson, getPrompt, platform = "shared", userOf }) {
  return async (ctx) => {
    if (!callJson) return { unavailable: true, detail: "no model configured" };
    const { text, id } = (getPrompt || require("../../prompts/registry").getPrompt)(promptName, platform);
    const r = await callJson(`${text}\n\n${userOf(ctx)}`);
    const items = Array.isArray(r) ? r : Array.isArray(r && (r.scenarios || r.cases || r.items)) ? (r.scenarios || r.cases || r.items) : null;
    if (!items || !items.length) return { ok: false, detail: `the model returned nothing usable (${id})` };
    return { ok: true, detail: `${items.length} from ${id}`, data: { items } };
  };
}
const scenariosHandler = (o) => aiHandler("scenario_batch", { ...o, userOf: (c) => `REQUIREMENT:\n${String(c.requirement || "").slice(0, 6000)}` });
const casesHandler = (o) => aiHandler("testcase_target", { ...o, userOf: (c) => {
  const sc = ((c.results || []).find((s) => s.id === "scenarios") || {}).data;
  return `REQUIREMENT:\n${String(c.requirement || "").slice(0, 3000)}\nSCENARIOS:\n${JSON.stringify(sc ? sc.items : []).slice(0, 4000)}`;
} });

// ---- HAR
const harContextOptions = (file) => ({ recordHar: { path: file, mode: "minimal" } });
function harHandler() {
  return async (ctx) => {
    if (!ctx.harPath) return { unavailable: true, detail: "the run did not record a HAR (pass harContextOptions to the web run)" };
    let har;
    try { har = JSON.parse(fs.readFileSync(ctx.harPath, "utf8")); } catch (e) { return { ok: false, detail: `HAR could not be read: ${e.message}` }; }
    const entries = (har.log && har.log.entries) || [];
    const bad = entries.filter((e) => e.response && e.response.status >= 400);
    const slow = entries.slice().sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 3).map((e) => `${Math.round(e.time || 0)}ms ${String((e.request || {}).url || "").split("?")[0]}`);
    return { ok: true, detail: `${entries.length} requests, ${bad.length} with status 400 or more; slowest: ${slow.join("; ") || "none"}`, data: { requests: entries.length, failed: bad.length } };
  };
}

// ---- performance (Locust)
function locustFile(steps, baseUrl) {
  const calls = steps.filter((s) => s && s.kind === "api" && s.url).map((s) => ({ m: String(s.method || "GET").toLowerCase(), u: /^https?:/i.test(s.url) ? s.url.replace(/^https?:\/\/[^/]+/i, "") : s.url, b: s.body }));
  if (!calls.length) return null;
  const q = JSON.stringify;
  return `from locust import HttpUser, task, between\n\nclass Phoenix(HttpUser):\n    host = ${q(baseUrl || "")}\n    wait_time = between(1, 3)\n` +
    calls.map((c, i) => `\n    @task\n    def call_${i}(self):\n        self.client.${["get", "post", "put", "patch", "delete"].includes(c.m) ? c.m : "get"}(${q(c.u)}${c.b !== undefined && c.m !== "get" ? `, json=${q(c.b)}` : ""})\n`).join("");
}
/** Locust file from a recorded HAR (the TestOps Performance Lab also builds its scripts from a HAR). Static assets and 3rd-party hosts are skipped. */
function locustFromHar(har, baseUrl) {
  const entries = ((har && har.log && har.log.entries) || []).filter((e) => e.request && /^https?:/i.test(e.request.url || ""));
  if (!entries.length) return null;
  const host = baseUrl ? new URL(baseUrl).host : new URL(entries[0].request.url).host;
  const steps = [], seen = new Set();
  for (const e of entries) {
    const u = new URL(e.request.url);
    if (u.host !== host || /\.(png|jpe?g|gif|svg|ico|css|js|woff2?|map)$/i.test(u.pathname)) continue;
    const m = String(e.request.method || "GET").toUpperCase();
    const key = m + " " + u.pathname + u.search;
    if (seen.has(key)) continue; seen.add(key);
    let body; try { body = e.request.postData && e.request.postData.text ? JSON.parse(e.request.postData.text) : undefined; } catch { body = undefined; }
    steps.push({ kind: "api", method: m, url: u.pathname + u.search, body });
  }
  return locustFile(steps, baseUrl || `${new URL(entries[0].request.url).protocol}//${host}`);
}
function performanceHandler({ exec = run, dir = "logs/performance", users = 10, rate = 2, time = "1m", maxFailPct = 1 } = {}) {
  return async (ctx) => {
    if (!ctx.baseUrl) return { unavailable: true, detail: "give the API address (baseUrl) to run a load test" };
    let code = null;
    if (ctx.harPath) { try { code = locustFromHar(JSON.parse(fs.readFileSync(ctx.harPath, "utf8")), ctx.baseUrl); } catch { /* fall back to steps */ } }
    code = code || locustFile(ctx.steps || [], ctx.baseUrl);
    if (!code) return { unavailable: true, detail: "no HAR or API steps to turn into a load test" };
    if (!has("locust", exec)) return { unavailable: true, detail: "locust is not installed (pip install locust)" };
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "locustfile.py");
    fs.writeFileSync(file, code);
    const r = exec("locust", ["-f", file, "--headless", "-u", String(users), "-r", String(rate), "-t", time, "--host", ctx.baseUrl, "--csv", path.join(dir, "run"), "--only-summary"]);
    let line = "";
    try { const rows = fs.readFileSync(path.join(dir, "run_stats.csv"), "utf8").trim().split("\n"); line = rows[rows.length - 1]; } catch { /* no csv */ }
    const cols = line.split(",");
    const reqs = Number(cols[2]), fails = Number(cols[3]);
    if (!reqs) return { ok: r.status === 0, detail: `locust finished (exit ${r.status}); no stats file` };
    const pct = (100 * fails) / reqs;
    return { ok: pct <= maxFailPct, detail: `${reqs} requests, ${fails} failed (${pct.toFixed(1)}%) at ${users} users for ${time}` };
  };
}

// ---- DAST (ZAP)
function dastHandler({ exec = run, dir = "logs/security", ajaxSpider = false } = {}) {
  return async (ctx) => {
    if (!ctx.baseUrl && !ctx.appUrl) return { unavailable: true, detail: "give the app address to scan" };
    const url = ctx.appUrl || ctx.baseUrl;
    fs.mkdirSync(dir, { recursive: true });
    const local = has("zap-baseline.py", exec);
    if (!local && !has("docker", exec)) return { unavailable: true, detail: "neither zap-baseline.py nor docker is installed" };
    const extra = ajaxSpider || ctx.ajaxSpider ? ["-j"] : [];
    const report = ["-J", local ? path.join(dir, "zap.json") : "zap.json", "-r", local ? path.join(dir, "zap.html") : "zap.html"];
    const args = local ? ["-t", url, ...report, ...extra] : ["run", "--rm", "-v", `${path.resolve(dir)}:/zap/wrk`, "zaproxy/zap-stable", "zap-baseline.py", "-t", url, ...report, ...extra];
    const r = exec(local ? "zap-baseline.py" : "docker", args);
    // zap-baseline exits 0 clean, 1 failures, 2 warnings, 3 error
    return { ok: r.status === 0, detail: r.status === 0 ? "no alerts" : r.status === 2 ? "warnings found (see report)" : r.status === 1 ? "failures found (see report)" : `scan error (exit ${r.status})` };
  };
}

// ---- feedback: a secret-free report per run
function feedbackHandler({ dir = "logs/reports" } = {}) {
  return async (ctx) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}.json`);
    const rows = (ctx.results || []).map(({ id, status, detail }) => ({ id, status, detail: String(detail || "").slice(0, 300) }));
    fs.writeFileSync(file, JSON.stringify({ goal: ctx.goal || "", stages: rows }, null, 2));
    return { ok: true, detail: `report saved: ${file}` };
  };
}

/** Everything wired, plus what the caller provides (execution, defects). */
function allHandlers({ callJson, getPrompt, exec, extra = {} } = {}) {
  return { scenarios: scenariosHandler({ callJson, getPrompt }), cases: casesHandler({ callJson, getPrompt }), har: harHandler(), performance: performanceHandler({ exec }), dast: dastHandler({ exec }), feedback: feedbackHandler(), ...extra };
}

module.exports = { locustFromHar, scenariosHandler, casesHandler, harHandler, harContextOptions, performanceHandler, locustFile, dastHandler, feedbackHandler, allHandlers };
