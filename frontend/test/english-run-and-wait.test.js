/** The English run, started from code (the pipeline), with a recorded HAR. Real Chromium; scripted model. */
const assert = require("assert");
const http = require("http"), fs = require("fs"), os = require("os"), path = require("path");
const { createEnglishEndpoint } = require("../english-endpoint");
const { webRunner } = require("../../engine/english-run");
const PAGE = `<!doctype html><title>Demo</title><body><button id="b" onclick="document.getElementById('o').textContent='Welcome back'">Log in</button><p id="o"></p></body>`;
const refOf = (prompt, word) => { const line = prompt.split("\n").find((l) => /^\[\d+\]/.test(l) && l.toLowerCase().includes(word)); return line ? Number(line.match(/^\[(\d+)\]/)[1]) : null; };
const model = async (prompt) => {
  const goal = (prompt.match(/^Goal: (.*)$/m) || [])[1] || "";
  if (/^Check that/i.test(goal)) return prompt.includes("Welcome back") ? { action: "done", reason: "showing" } : { action: "fail", reason: "text missing" };
  if (!prompt.includes("No actions yet.")) return { action: "done", reason: "did it" };
  if (/log in/i.test(goal)) return { action: "tap", ref: refOf(prompt, "log in") };
  return { action: "fail", reason: "no idea" };
};
(async () => {
  let ok = true;
  try { const b = await require("../english-endpoint").loadPlaywright().chromium.launch({ executablePath: process.env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined }); await b.close(); } catch (e) { ok = false; console.log(`  SKIPPED - no browser (${String(e.message).split("\n")[0]})`); }
  if (!ok) return;
  const site = http.createServer((_q, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(PAGE); });
  await new Promise((r) => site.listen(0, r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const ep = createEnglishEndpoint({ webRunner: (page) => webRunner(page, { callModel: model, vision: false }), launchBrowser: async () => require("../english-endpoint").loadPlaywright().chromium.launch({ executablePath: process.env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined }) });
  const har = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "har-")), "a.har");
  const good = await ep.runAndWait({ platform: "web", steps: "Click the Log in button\nCheck that Welcome back is shown", url, harPath: har });
  assert.strictEqual(good.status, "passed", JSON.stringify(good));
  assert.ok(/Local/.test(good.where || ""), good.where);
  const j = JSON.parse(fs.readFileSync(har, "utf8")); assert.ok(j.log.entries.length >= 1);
  const bad = await ep.runAndWait({ platform: "web", steps: "Check that Goodbye is shown", url });
  assert.notStrictEqual(bad.status, "passed"); assert.ok(bad.steps.some((s) => s.status === "failed"));
  site.close();
  console.log("english-run-and-wait tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
