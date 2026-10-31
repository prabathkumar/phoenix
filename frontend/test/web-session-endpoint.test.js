const assert = require("assert");
const net = require("net");
const { freePort, handleStartWebSession } = require("../web-session-endpoint");
const { Readable } = require("stream");

(async () => {
  // Range: picks inside it and skips a busy port.
  const base = 38100 + Math.floor(Math.random() * 500);
  const busy = net.createServer();
  await new Promise((r) => busy.listen(base, r));
  const got = await freePort(`${base}-${base + 2}`);
  assert.ok(got > base && got <= base + 2, `got ${got}`);
  // Exhausted range gives a clear message.
  await assert.rejects(() => freePort(`${base}-${base}`), /no free port in/);
  busy.close();
  // No range: any free port.
  assert.ok((await freePort("")) > 0);
  // Record on: passes runOn and a cleaned target to the recorder; default is local.
  const call = async (body) => {
    let seen; let out;
    const req = Readable.from([JSON.stringify(body)]);
    const res = { writeHead(c) { this.code = c; }, end(t) { out = JSON.parse(t); } };
    await handleStartWebSession(req, res, async (o) => { seen = o; return { wss: { on() {} } }; });
    return { seen, out, code: res.code };
  };
  const a = await call({ url: "https://x.test" });
  assert.strictEqual(a.seen.runOn, "local");
  const b = await call({ url: "https://x.test", runOn: "BrowserStack", target: { provider: "browserstack", browser: "edge", accessKey: "SECRETKEY9" } });
  assert.strictEqual(b.seen.runOn, "browserstack");
  assert.strictEqual(b.seen.target.browser, "edge");
  assert.ok(!JSON.stringify(b.seen).includes("SECRETKEY9"));
  console.log("  ok - web recording: Record on is passed through (local by default), target cleaned");
  console.log("  ok - web session ports: range respected, busy ports skipped, clear error when full");
})().catch((e) => { console.error("  FAIL -", e.stack); process.exit(1); });
