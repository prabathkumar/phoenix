const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gwe-"));
process.env.TESTOPS_GATEWAY_DIR = dir; process.env.TESTOPS_GATEWAY_LOG = path.join(dir, "c.jsonl");
const { route, handle } = require("../gateway-endpoint");
const env = process.env;
const fetchFn = async (u, o) => ({ ok: true, status: 200, text: async () => JSON.stringify({ result: JSON.parse(o.body).method === "tools/list" ? { tools: [{ name: "t" }] } : {} }) });

(async () => {
  const post = (p, b, deps = {}) => route("POST", p, {}, b, { env, ...deps });
  let r = await post("prompt", { name: "p1", text: "Do {{x}}", by: "me" });
  assert.strictEqual(r.code, 200); assert.strictEqual(r.json.prompt.published, 1);
  r = await post("prompt", { name: "../bad", text: "t" }); assert.strictEqual(r.code, 400);
  r = await route("GET", "prompts", {}, null, { env }); assert.strictEqual(r.json.prompts[0].name, "p1");
  r = await route("GET", "prompt", { name: "nope" }, null, { env }); assert.strictEqual(r.code, 404);
  await post("settings", { name: "p1", platform: "shared", guardrails: ["no-secrets"], models: ["m"] });
  assert.deepStrictEqual((await route("GET", "prompt", { name: "p1" }, null, { env })).json.prompt.models, ["m"]);

  // playground goes through the gateway and the log shows it
  r = await post("test", { name: "p1", vars: { x: "1" } }, { providers: { m: async (pr) => ({ echo: pr }) } });
  assert.ok(r.json.ok && r.json.value.echo === "Do 1");
  r = await route("GET", "logs", {}, null, { env }); assert.strictEqual(r.json.calls[0].status, "ok");

  // guardrails save rejects an unknown type; MCP never shows headers
  assert.strictEqual((await post("guardrails", { rules: [{ id: "x", type: "bogus", action: "block" }] })).code, 400);
  assert.strictEqual((await post("guardrails", { rules: [{ id: "x", type: "pii", applies: "input", action: "redact" }] })).code, 200);
  await post("mcp/add", { id: "m1", url: "https://m/mcp", headers: { Authorization: "Bearer SEKRET" } });
  r = await post("mcp/refresh", { id: "m1" }, { fetchFn }); assert.deepStrictEqual(r.json.server.tools, [{ name: "t", description: "" }]);
  assert.ok(!JSON.stringify((await route("GET", "mcp", {}, null, { env })).json).includes("SEKRET"));
  assert.strictEqual((await route("GET", "nothing", {}, null, { env })).code, 404);

  // The page: loads, lists prompts, saves a new version through the real HTTP handler.
  const server = http.createServer((req, res) => req.url.startsWith("/api/gateway/") ? handle(req, res) : (res.writeHead(200, { "Content-Type": "text/html" }), res.end(fs.readFileSync(path.join(__dirname, "..", "gateway.html")))));
  await new Promise((ok) => server.listen(0, ok));
  const { chromium } = require("../../web/node_modules/playwright");
  const browser = await chromium.launch({ executablePath: process.env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message));
    await page.goto(`http://localhost:${server.address().port}/`);
    await page.waitForSelector("#plist button");
    assert.ok((await page.textContent("#plist")).includes("p1"));
    await page.click("#plist button"); await page.waitForSelector("#peditor textarea");
    await page.fill("#peditor textarea", "Do {{x}} better"); await page.click("text=Save as new version");
    await page.waitForFunction(() => document.querySelector("#pmsg") && /v2/.test(document.querySelector("#pmsg").textContent));
    await page.click('#tabs button[data-t="guard"]'); await page.waitForSelector("#gtable tbody tr");
    await page.click('#tabs button[data-t="logs"]'); await page.waitForSelector("#ltable tbody tr");
    assert.deepStrictEqual(errs, []);
  } finally { await browser.close(); server.close(); }
  console.log("gateway-endpoint tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
