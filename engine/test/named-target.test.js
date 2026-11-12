const assert = require("assert");
const { parseRepeat, mismatch, MATCH_RULES } = require("../core/named-target");
const { runGoalLoop } = require("../core/goal-loop");
const { resolveByInstruction, buildPrompt } = require("../core/semantic-resolve");

// a page where the logo does nothing visible when clicked, and a Login button sits next to it
function page() {
  const clicks = [];
  const els = [
    { ref: 0, tag: "a", role: "link", name: "Acme", hint: "logo", editable: false, disabled: false, inViewport: true },
    { ref: 1, tag: "button", role: "button", name: "Login", editable: false, disabled: false, inViewport: true },
  ];
  return { clicks, surface: {
    platform: "web", url: () => "http://x/", snapshot: async () => els.map((e) => ({ ...e })), lines: async () => ["Welcome"], screenshot: async () => ({}),
    selectorFor: async (ref) => ({ selector: `css=#e${ref}`, fragile: false }),
    perform: async (a) => { clicks.push(a.ref); return { ok: true }; },
  } };
}

(async () => {
  assert.deepStrictEqual(parseRepeat("click the logo 10 times"), { text: "click the logo", times: 10 });
  assert.strictEqual(parseRepeat("click the logo twice").times, 2);
  assert.strictEqual(parseRepeat("tap Sign in").times, 1);
  assert.strictEqual(parseRepeat("click the logo 500 times").times, 50); // capped

  // the reported bug: 10 clicks on the logo, never the Login button
  let p = page(), prompts = [];
  let r = await runGoalLoop(p.surface, "click the logo 10 times", { callModel: async (pr) => { prompts.push(pr); return { action: "tap", ref: 0 }; } });
  assert.ok(r.success, r.reason);
  assert.deepStrictEqual(p.clicks, Array(10).fill(0));
  assert.strictEqual(prompts.length, 1, "resolved once, then repeated");
  assert.ok(/Match the thing the instruction NAMES/.test(prompts[0]) && /logo/.test(prompts[0]) && !/10 times/.test(prompts[0].split("Goal:")[1].split("\n")[0]));

  // a model that picks Login anyway is stopped, and told why
  p = page(); let n = 0;
  r = await runGoalLoop(p.surface, "click the logo 10 times", { callModel: async (pr) => (n++ === 0 ? { action: "tap", ref: 1 } : /not a logo/.test(pr) ? { action: "tap", ref: 0 } : { action: "fail", reason: "gave up" }) });
  assert.ok(r.success && !p.clicks.includes(1), `Login must never be clicked: ${p.clicks}`);

  // if the logo is not on the page, say so instead of clicking something else
  p = page(); const only = p.surface.snapshot; p.surface.snapshot = async () => (await only()).filter((e) => e.ref === 1);
  r = await runGoalLoop(p.surface, "click the logo", { callModel: async () => ({ action: "tap", ref: 1 }) });
  assert.ok(!r.success && !p.clicks.length, "no click on a substitute");

  // identical "Buy now" buttons are told apart by the card they sit in
  const cards = [{ ref: 0, tag: "a", role: "link", name: "BUY NOW", within: "Apple iPhone 17 RRP RM 4,299" }, { ref: 1, tag: "a", role: "link", name: "BUY NOW", within: "vivo X500 RRP RM 5,299" }];
  const pr = buildPrompt({ instruction: "Click Buy now on the vivo X500", kind: "tap", elements: cards });
  assert.ok(/\[1\] link "BUY NOW" \(in: "vivo X500/.test(pr) && /whose in: text/.test(pr), "card context reaches the model");

  // semantic layer: same guard
  p = page();
  let res = await resolveByInstruction(p.surface, "click the logo", { callModel: async () => ({ ref: 1 }) });
  assert.ok(!res.resolved && /not a logo/.test(res.reason));
  res = await resolveByInstruction(p.surface, "click the logo", { callModel: async () => ({ ref: 0 }) });
  assert.ok(res.resolved && res.ref === 0);
  assert.ok(/\blogo\b/.test(buildPrompt({ instruction: "click the logo", kind: "tap", elements: await p.surface.snapshot() })), "the element list marks the logo");
  assert.strictEqual(mismatch("click Login", { name: "Login", role: "button" }), null);
  assert.ok(MATCH_RULES.includes("Never choose a different element"));
  console.log("named-target tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
