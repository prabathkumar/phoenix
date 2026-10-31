const assert = require("node:assert");
const T = require("../core/traceability");
const { traceabilityHandler } = require("../core/handlers");
(async () => {
  const files = {
    "test-cases/login.json": JSON.stringify({ name: "User can log in with email", steps: ["open login page", "enter email and password", "click Sign in"] }),
    "generated/cart.spec.ts": "test('adds item to the cart', async () => {})",
    "generated/legacy.spec.ts": "test('old banner check', async () => {})",
    "src/app.js": "ignored", "node_modules/x/test/a.test.js": "ignored",
  };
  const repo = { defaultBranch: async () => "main", listFiles: async () => Object.keys(files), readFile: async (p) => files[p] };
  const req = "User can log in with email and password.\nUser can add an item to the cart.\nUser can export an invoice as PDF.";

  const arts = await T.collectArtifacts(repo, "main");
  assert.deepStrictEqual(arts.map((a) => a.path).sort(), ["generated/cart.spec.ts", "generated/legacy.spec.ts", "test-cases/login.json"]);

  // no model: word match, labelled a guess
  const w = await T.check({ requirement: req, repo });
  assert.strictEqual(w.source, "words");
  assert.strictEqual(w.coverage.find((c) => c.id === "R3").status, "missing");
  assert.strictEqual(w.coverage.find((c) => c.id === "R1").status, "possible");
  assert.ok(w.unrequired.some((u) => u.path === "generated/legacy.spec.ts"));

  // model: invented evidence dropped, unsupported "covered" becomes missing
  const callJson = async (p) => /separate thing/.test(p) ? { statements: ["log in", "add to cart", "export invoice"] } : {
    coverage: [{ id: "R1", status: "covered", evidence: ["test-cases/login.json"] }, { id: "R2", status: "covered", evidence: ["made/up.js"] }, { id: "R3", status: "missing", evidence: [] }],
    unrequired: [{ path: "generated/legacy.spec.ts", note: "no one asked" }, { path: "ghost.js" }] };
  const a = await T.check({ requirement: req, repo, callJson });
  assert.strictEqual(a.source, "ai");
  assert.deepStrictEqual(a.coverage.map((c) => c.status), ["covered", "missing", "missing"]);
  assert.strictEqual(a.unrequired.length, 1);
  assert.strictEqual(a.summary.covered, 1);

  // model throws: falls back
  const f = await T.check({ requirement: req, repo, callJson: async () => { throw new Error("down"); } });
  assert.strictEqual(f.source, "words");

  // handler
  const h = traceabilityHandler({ callJson, connectRepo: () => repo });
  assert.ok((await h({ requirement: req })).unavailable);
  assert.ok((await h({ requirement: req, repoRequest: { provider: "github" } })).unavailable);
  const r = await h({ requirement: req, repoRequest: { provider: "github", project: "o/r" } });
  assert.strictEqual(r.ok, false); assert.match(r.detail, /1 covered/);
  console.log("traceability tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
