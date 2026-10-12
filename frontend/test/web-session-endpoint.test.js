const assert = require("assert");
const net = require("net");
const { freePort } = require("../web-session-endpoint");

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
  console.log("  ok - web session ports: range respected, busy ports skipped, clear error when full");
})().catch((e) => { console.error("  FAIL -", e.stack); process.exit(1); });
