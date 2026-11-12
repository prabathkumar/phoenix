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

  // a single plain click is finished after one click (reported: "Click the Devices menu" tapped Devices 8 times)
  p = page(); let calls = 0;
  r = await runGoalLoop(p.surface, "Click the Login button", { callModel: async () => { calls++; return { action: "tap", ref: 1 }; } });
  assert.ok(r.success && p.clicks.length === 1 && calls <= 1, `one click, got ${p.clicks}`);
  p = page(); calls = 0;
  r = await runGoalLoop(p.surface, "go to the page and click Login", { maxSteps: 3, callModel: async () => { calls++; return { action: "tap", ref: 1 }; } });
  assert.ok(calls > 1, "multi-part goals keep going");

  // identical "Buy now" buttons are told apart by the card they sit in
  const cards = [{ ref: 0, tag: "a", role: "link", name: "BUY NOW", within: "Apple iPhone 17 RRP RM 4,299" }, { ref: 1, tag: "a", role: "link", name: "BUY NOW", within: "vivo X500 RRP RM 5,299" }];
  const pr = buildPrompt({ instruction: "Click Buy now on the vivo X500", kind: "tap", elements: cards });
  assert.ok(/\[1\] link "BUY NOW" \(in: "vivo X500/.test(pr) && /whose in: text/.test(pr), "card context reaches the model");

  // reading the page: the Buy now inside the vivo X500 card, chosen with no model at all
  const { domMatch, plainName, enterTarget } = require("../core/named-target");
  let dm = domMatch("Click Buy now on the vivo X500", cards);
  assert.ok(dm.element && dm.element.ref === 1, dm.why);
  assert.strictEqual(domMatch("click buy now against the vivoX500.", cards).element.ref, 1, "spacing and case do not matter");
  assert.ok(!domMatch("Click Buy now on the Pixel 9", cards).element, "not on the page: no substitute");
  assert.strictEqual(domMatch("Click Login", cards), null);
  let asked = 0; p = page(); p.surface.snapshot = async () => cards.map((e) => ({ ...e, editable: false, disabled: false }));
  r = await runGoalLoop(p.surface, "Click Buy now on the vivo X500", { callModel: async () => { asked++; return { action: "done" }; } });
  assert.ok(r.success && asked === 0 && p.clicks.join() === "1", `model not asked, card 1 clicked: ${asked} ${p.clicks}`);

  // reported: "Click Explore Devices" tapped a BUY NOW button because the menu item was not on the page
  p = page(); p.surface.snapshot = async () => [{ ref: 0, tag: "a", role: "link", name: "BUY NOW", editable: false, disabled: false, inViewport: true }];
  r = await runGoalLoop(p.surface, "Click Explore Devices", { callModel: async () => ({ action: "tap", ref: 0 }) });
  assert.ok(!r.success && !p.clicks.length, `no substitute click: ${p.clicks} ${r.reason}`);
  r = await runGoalLoop(p.surface, "Click Buy now on the vivo X500", { callModel: async () => ({ action: "none" }) });
  assert.ok(!r.success && /nothing|vivo/i.test(r.reason) && !/unknown action/.test(r.reason), r.reason);
  assert.strictEqual(mismatch("Click Explore Devices", { name: "Explore Devices", role: "link" }), null);
  assert.strictEqual(mismatch("Click the Devices menu", { name: "Devices", role: "link" }), null);
  assert.ok(mismatch("Click Buy now on the vivo X500", { name: "iPhone", role: "link" }));
  assert.strictEqual(mismatch("click the logo", { name: "Acme", role: "link", hint: "logo" }), null);

  // plain label: "Click Explore Devices" finds that link even though "Devices" and others are on the page
  const menu = [{ ref: 0, role: "link", name: "Devices" }, { ref: 1, role: "link", name: "Explore Devices" }, { ref: 2, role: "link", name: "Postpaid Plans" }, { ref: 3, role: "link", name: "Yes Trade-in" }];
  assert.strictEqual(plainName("Click Explore Devices", menu).element.ref, 1);
  assert.strictEqual(plainName("Click the Devices menu", menu).element.ref, 0, "exact label beats one that only contains it");
  assert.strictEqual(plainName("Click Pakej NUTP", menu), null);

  // reported: "Select colour Starry Gray" tapped the swatch, then kept going (iPhone, Devices, BUY NOW) until it landed on another phone
  const sw = [{ ref: 0, role: "button", name: "Sunny White" }, { ref: 1, role: "button", name: "Starry Gray" }, { ref: 2, role: "link", name: "iPhone" }];
  assert.strictEqual(plainName("Select colour Starry Gray", sw).element.ref, 1);
  p = page(); p.surface.snapshot = async () => sw.map((e) => ({ ...e, editable: false, disabled: false }));
  r = await runGoalLoop(p.surface, "Select colour Starry Gray", { callModel: async () => { throw new Error("model must not be called"); } });
  assert.ok(r.success && p.clicks.join() === "1", `one tap on the swatch, then stop: ${p.clicks}`);

  // the word "colour" appears in every swatch's id; it must not make "Sunny White" pass for "Starry Gray"
  assert.ok(mismatch("Select colour Starry Gray", { name: "Sunny White", role: "button", id: "colour-sunny-white" }));
  assert.strictEqual(mismatch("Select colour Starry Gray", { name: "Starry Gray", role: "button", id: "colour-starry-gray" }), null);

  // reported: "Enter 010246789 in the mobile number field" typed into 'Yes Number *' again and again
  const form = [{ ref: 0, role: "textbox", name: "Yes Number *", editable: true }, { ref: 1, role: "button", name: "REQUEST TAC" }];
  const et = enterTarget("Enter 010246789 in the mobile number field", form);
  assert.ok(et && et.element.ref === 0 && et.text === "010246789", "field found by the shared word 'number'");
  assert.strictEqual(enterTarget("Enter 1 in the postcode field", form), null, "no field with that name: the model or a person decides");
  p = page(); p.surface.snapshot = async () => form.map((e) => ({ ...e, disabled: false, editable: !!e.editable }));
  let typedN = 0; p.surface.perform = async (a) => { if (a.kind === "type") typedN++; return { ok: true }; };
  r = await runGoalLoop(p.surface, "Enter 010246789 in the mobile number field", { callModel: async () => { throw new Error("model must not be called"); } });
  assert.ok(r.success && typedN === 1, `one type, then stop: ${typedN} ${r.reason}`);

  // reported: "Click Next" tapped the 'Personal' tab (and passed): 'next' was a filler word, and the real NEXT was disabled
  assert.ok(mismatch("Click Next", { name: "Personal", role: "tab", id: "tabNav-personal" }), "Personal is not Next");
  assert.strictEqual(mismatch("Click Next", { name: "NEXT", role: "button" }), null);
  const bar = [{ ref: 0, role: "tab", name: "Personal" }, { ref: 1, role: "button", name: "NEXT", disabled: true }];
  assert.ok(plainName("Click Next", bar).blocked, "the disabled NEXT is reported, not skipped");
  p = page(); p.surface.snapshot = async () => bar.map((e) => ({ ...e, editable: false, disabled: !!e.disabled }));
  r = await runGoalLoop(p.surface, "Click Next", { callModel: async () => ({ action: "tap", ref: 0 }) });
  assert.ok(!r.success && /disabled/.test(r.reason) && !p.clicks.length, `fails, names the reason, clicks nothing: ${r.reason} ${p.clicks}`);

  // reported: "Select the Infinite+ payment plan" tapped the 'Mobile Plans' nav item because 'plan' matched
  assert.ok(mismatch("Select the Infinite+ payment plan", { name: "Mobile Plans", role: "link" }), "Mobile Plans is not Infinite+");
  assert.strictEqual(mismatch("Select the Infinite+ payment plan", { name: "Infinite+", role: "h2" }), null);

  // the button becomes enabled a moment later: wait for it instead of failing
  p = page(); let polls = 0;
  p.surface.snapshot = async () => { polls += 1; return [{ ref: 0, role: "button", name: "NEXT", editable: false, disabled: polls < 3 }]; };
  r = await runGoalLoop(p.surface, "Click Next", { blockedWaitMs: 1, callModel: async () => ({ action: "tap", ref: 9 }) });
  assert.ok(r.success && p.clicks.length === 1, `waits for NEXT to enable, then taps it: ${r.reason}`);

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
