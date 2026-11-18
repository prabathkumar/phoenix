// Smoke test for the Chrome extension in a real Chromium. Needs: the hub running on :18091 (PHOENIX_DATA_DIR set, see docs/LAPTOP_RUNNER.md),
// a page to open at http://localhost:18092/index.html with an <input id="q"> and a <button id="b" onclick="document.title='clicked'">,
// and CHROME_PATH pointing at a Chromium that allows extensions (new headless). It skips the options page, because Chrome's permission prompt needs a person.
const { chromium } = require(require.resolve("playwright", { paths: [__dirname + "/../../web"] }));
const WS = require(require.resolve("ws", { paths: [__dirname + "/../../web"] }));
const EXT = __dirname + "/../phoenix-runner", HUB = "http://localhost:18091", H = { "X-User": "ann@ytl.com", "content-type": "application/json" };
const j = (p, b, m = "POST") => fetch(HUB + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json().then((x) => [r.status, x]));
(async () => {
  const code = (await j("/api/runners/pair", { allow: ["localhost"] }))[1].code;
  const reg = await fetch(HUB + "/api/runners/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "ext" }) }).then((r) => r.json());
  const ctx = await chromium.launchPersistentContext(process.env.PROFILE || "/tmp/phoenix-ext-profile", { executablePath: process.env.CHROME_PATH, headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  console.log("extension loaded:", sw.url().split("/")[2].slice(0, 8) + "…");
  await sw.evaluate((c) => chrome.storage.local.set({ phoenixRunner: { server: c.server, token: c.token, runnerId: c.runnerId, allow: c.allow, enabled: true } }), { server: HUB, ...reg });
  
  for (let i = 0; i < 20; i++) { if ((await j("/api/runners", null, "GET"))[1].runners[0].online) break; await new Promise((r) => setTimeout(r, 500)); }
  const list = (await j("/api/runners", null, "GET"))[1].runners; console.log("runner online:", list[0].online);
  const bad = await j(`/api/runners/${reg.runnerId}/jobs`, { kind: "live", url: "https://evil.example.org" }); console.log("outside allowlist:", bad[0]);
  const job = (await j(`/api/runners/${reg.runnerId}/jobs`, { kind: "live", url: "http://localhost:18092/index.html" }))[1];
  const v = new WS(`ws://localhost:18091/api/runners/jobs/${job.jobId}/view?ticket=${job.viewTicket}`);
  const got = { frames: 0, page: null, errors: [], typed: false };
  v.on("message", (d) => { const m = JSON.parse(String(d)); if (m.type === "frame") got.frames++; else if (m.type === "page") got.page = m; else if (m.type === "action-error") got.errors.push(m.message); else if (m.type === "text-entered") got.typed = true; });
  await new Promise((r) => v.on("open", r));
  await new Promise((r) => setTimeout(r, 4000));
  console.log("frames received:", got.frames, "page:", got.page && got.page.title);
  const tp = ctx.pages().find((p) => p.url().startsWith("http://localhost:18092"));
  const geo = await tp.evaluate(() => { const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }; return { w: innerWidth, h: innerHeight, q: r("q"), b: r("b") }; });
  console.log("viewport", geo.w, geo.h);
  v.send(JSON.stringify({ type: "tap", xRatio: geo.q.x / geo.w, yRatio: geo.q.y / geo.h })); await new Promise((r) => setTimeout(r, 500));
  v.send(JSON.stringify({ type: "type", value: "hello from phoenix" })); await new Promise((r) => setTimeout(r, 800));
  v.send(JSON.stringify({ type: "tap", xRatio: geo.b.x / geo.w, yRatio: geo.b.y / geo.h })); await new Promise((r) => setTimeout(r, 600));
  console.log("button click changed title to:", await tp.title());
  v.send(JSON.stringify({ type: "navigate", url: "https://evil.example.org/" })); await new Promise((r) => setTimeout(r, 800));
  v.send(JSON.stringify({ type: "ai-goal", goal: "x" })); await new Promise((r) => setTimeout(r, 500));
  const pages = ctx.pages().filter((p) => p.url().startsWith("http://localhost:18092"));
  console.log("tabs on target:", pages.length, "| input value:", pages[0] ? await pages[0].inputValue("#q") : "n/a");
  console.log("typed ack:", got.typed, "| errors:", JSON.stringify(got.errors));
  v.send(JSON.stringify({ type: "stop" })); await new Promise((r) => setTimeout(r, 1000));
  const fin = (await j(`/api/runners/jobs/${job.jobId}`, null, "GET"))[1]; console.log("job after stop:", fin.status);
  await ctx.close(); process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
