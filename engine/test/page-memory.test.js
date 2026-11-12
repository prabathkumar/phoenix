const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { test } = require("node:test");
const { pageKey, observe, describe } = require("../core/page-memory");

const tmp = () => path.join(os.tmpdir(), `page-memory-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
const els = (...names) => names.map((n, i) => ({ ref: i, role: "button", name: n }));

test("pageKey ignores product ids, queries and trailing slashes", () => {
  assert.strictEqual(pageKey("https://store.yes.my/x500/cart/?a=1#b"), "https://store.yes.my/x500/cart");
  assert.strictEqual(pageKey("https://s.my/orders/12345/view"), "https://s.my/orders/:id/view");
});

test("first sight is unknown, second identical sight is known; counters in names do not matter", () => {
  const f = tmp();
  try {
    assert.strictEqual(observe("https://s.my/cart", els("NEXT", "581 People viewing"), { file: f }).known, false);
    assert.strictEqual(observe("https://s.my/cart", els("NEXT", "612 People viewing"), { file: f }).known, true);
  } finally { fs.rmSync(f, { force: true }); }
});

test("a changed page reports what is gone and what is new, in plain words", () => {
  const f = tmp();
  try {
    observe("https://s.my/cart", els("NEXT", "New Line", "Existing", "Starry Gray"), { file: f });
    const o = observe("https://s.my/cart", els("Continue", "New Line", "Existing", "Starry Gray"), { file: f });
    assert.ok(!o.known && o.drift.removed.includes("button|next") && o.drift.added.includes("button|continue"));
    assert.match(describe(o), /gone: "next".*new: "continue"/);
  } finally { fs.rmSync(f, { force: true }); }
});

test("a different state of the same page (new buttons appear after a tap) is remembered, not an alarm", () => {
  const f = tmp();
  try {
    observe("https://s.my/cart", els("NEXT", "New Line", "Existing"), { file: f });
    observe("https://s.my/cart", els("NEXT", "New Line", "Existing", "36 Months", "24 Months"), { file: f });
    assert.strictEqual(observe("https://s.my/cart", els("NEXT", "New Line", "Existing", "36 Months", "24 Months"), { file: f }).known, true);
  } finally { fs.rmSync(f, { force: true }); }
});

test("a memory failure never throws", () => {
  assert.strictEqual(observe("https://s.my/", els("a"), { file: "/nonexistent-dir/x/y.db" }), null);
});

test("goal loop: a failing step on a changed page says what changed; the loop still works when memory throws", async () => {
  const { runGoalLoop } = require("../core/goal-loop");
  const mk = (els) => ({ platform: "web", url: () => "https://s.my/cart", snapshot: async () => els, lines: async () => [], screenshot: async () => null, perform: async () => ({ ok: true }), selectorFor: () => ({ selector: "x", fragile: false }) });
  const notes = [];
  const r = await runGoalLoop(mk([{ ref: 0, role: "button", name: "Continue", editable: false }]), "Click Next", {
    blockedWaitMs: 1, pageNotes: notes, callModel: async () => ({ action: "none" }),
    pageMemory: () => "this page differs from the last time it was seen (gone: \"next\")",
  });
  assert.ok(!r.success && /differs/.test(notes[0]));
  const r2 = await runGoalLoop(mk([{ ref: 0, role: "button", name: "Continue", editable: false }]), "Click Next", { blockedWaitMs: 1, callModel: async () => ({ action: "none" }), pageMemory: () => { throw new Error("db"); } });
  assert.ok(!r2.success);
});
