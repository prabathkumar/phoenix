const assert = require("assert");
const td = require("../core/testdata");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`ok - ${name}`); } catch (e) { failed += 1; console.log(`not ok - ${name}\n  ${e.stack}`); }
}

test("classify: logins and issued values must already exist", () => {
  assert.strictEqual(td.classify("LOGIN_PASSWORD").mustExist, true);
  assert.strictEqual(td.classify("LOGIN_PHONE").mustExist, true);
  assert.strictEqual(td.classify("OTP").mustExist, true);
  assert.strictEqual(td.classify("API_TOKEN").mustExist, true);
  assert.strictEqual(td.classify("CUSTOMER_ID").mustExist, true);
});

test("classify: new users and plain fields can be generated", () => {
  assert.strictEqual(td.classify("NEW_USER_PASSWORD").mustExist, false);
  assert.strictEqual(td.classify("EMAIL").mustExist, false);
  assert.strictEqual(td.classify("AMOUNT").mustExist, false);
  assert.strictEqual(td.classify("NEW_CUSTOMER_ID").mustExist, false);
  assert.strictEqual(td.classify("LOGIN_PASSWORD").secret, true);
});

test("classify: hint overrides the name", () => {
  assert.strictEqual(td.classify("CUSTOMER_ID", { existing: false }).mustExist, false);
  assert.strictEqual(td.classify("NOTE", { existing: true }).mustExist, true);
  assert.strictEqual(td.classify("OTP", { existing: false }).mustExist, true);
});

test("generate is deterministic per seed and differs across seeds", () => {
  assert.strictEqual(td.generate("EMAIL", {}, { seed: "a" }), td.generate("EMAIL", {}, { seed: "a" }));
  assert.notStrictEqual(td.generate("EMAIL", {}, { seed: "a" }), td.generate("EMAIL", {}, { seed: "b" }));
});

test("generate: formats", () => {
  assert.match(td.generate("EMAIL"), /^qa\.[0-9a-f]{8}@example\.com$/);
  assert.match(td.generate("PHONE"), /^202-555-01\d\d$/);
  assert.match(td.generate("DOB"), /^(19[6-9]\d|200[0-2])-\d\d-\d\d$/);
  assert.match(td.generate("AMOUNT"), /^\d+\.\d\d$/);
  assert.match(td.generate("X", { format: "REF-##?" }), /^REF-\d\d[a-z]$/);
  const pw = td.generate("NEW_USER_PASSWORD");
  assert.ok(pw.length >= 14 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /\d/.test(pw) && /[!@#$%^&*]/.test(pw));
});

test("generate: must-exist valid is undefined; invalidCredential is not", () => {
  assert.strictEqual(td.generate("LOGIN_PASSWORD"), undefined);
  assert.ok(td.generate("LOGIN_PASSWORD", {}, { variant: "invalidCredential" }));
  assert.strictEqual(td.generate("OTP", {}, { variant: "invalidCredential" }), "000000");
});

test("generate: negative variants", () => {
  assert.strictEqual(td.generate("EMAIL", {}, { variant: "empty" }), "");
  assert.strictEqual(td.generate("NOTE", { maxLength: 10 }, { variant: "tooLong" }).length, 11);
  assert.strictEqual(td.generate("EMAIL", {}, { variant: "wrongFormat" }), "not-an-email");
  assert.strictEqual(td.generate("AMOUNT", { min: 5 }, { variant: "belowMin" }), "4");
  assert.strictEqual(td.generate("AMOUNT", { max: 50 }, { variant: "aboveMax" }), "51");
});

test("variantsFor gives a good value and the usual bad ones", () => {
  const v = td.variantsFor("EMAIL");
  assert.deepStrictEqual(Object.keys(v), ["valid", "empty", "tooLong", "wrongFormat"]);
  assert.ok(Object.keys(td.variantsFor("AMOUNT")).includes("belowMin"));
  assert.ok(!("valid" in td.variantsFor("LOGIN_PASSWORD")));
});

test("generateBody fills a sample and leaves must-exist fields as placeholders", () => {
  const { body, needsYou } = td.generateBody(
    { email: "a@b.c", age: 3, active: true, tags: ["x"], password: "p", profile: { firstName: "x" } },
    { seed: "s", hints: { PASSWORD: { existing: true } } });
  assert.match(body.email, /@example\.com$/);
  assert.strictEqual(typeof body.age, "number");
  assert.strictEqual(typeof body.active, "boolean");
  assert.strictEqual(body.password, "${PASSWORD}");
  assert.deepStrictEqual(needsYou, ["PASSWORD"]);
  assert.ok(Array.isArray(body.tags) && typeof body.tags[0] === "string");
  assert.ok(FIRSTS_OK(body.profile.firstName));
});
function FIRSTS_OK(v) { return typeof v === "string" && v.length > 0; }

test("generateBody honours a schema", () => {
  const { body } = td.generateBody({}, {
    schema: { type: "object", properties: { qty: { type: "integer", minimum: 2, maximum: 4 }, kind: { enum: ["a", "b"] }, when: { type: "string", format: "date" } } },
  });
  assert.ok(body.qty >= 2 && body.qty <= 4 && Number.isInteger(body.qty));
  assert.ok(["a", "b"].includes(body.kind));
  assert.match(body.when, /^\d{4}-\d\d-\d\d$/);
});

test("bodyMutations: missing, wrong type, empty", () => {
  const m = td.bodyMutations({ phone: "1", n: 2, inner: { ok: true } });
  const names = m.map((x) => x.name);
  assert.ok(names.includes("missing phone"));
  assert.ok(names.includes("wrong type for n"));
  assert.ok(names.includes("empty phone"));
  assert.ok(names.includes("wrong type for inner.ok"));
  const miss = m.find((x) => x.name === "missing phone").body;
  assert.ok(!("phone" in miss) && miss.n === 2);
});

test("requiredNames: skips api-saved values and values set in env", () => {
  const steps = [
    "type ${USER} into the box",
    { method: "POST", url: "/login", body: { u: "${USER}" }, save: { TOKEN: "$.token" } },
    { method: "GET", url: "/me", headers: { Authorization: "Bearer ${TOKEN}" } },
    "type ${CITY}",
  ];
  assert.deepStrictEqual(td.requiredNames(steps, { env: {} }), ["USER", "CITY"]);
  assert.deepStrictEqual(td.requiredNames(steps, { env: { CITY: "KL" } }), ["USER"]);
});

test("planTestData: generates what it can, asks for what it cannot", () => {
  const plan = td.planTestData({ names: ["EMAIL", "LOGIN_PHONE", "LOGIN_PASSWORD"], seed: "s" });
  assert.strictEqual(plan.ready, false);
  assert.deepStrictEqual(plan.needsYou, ["LOGIN_PHONE", "LOGIN_PASSWORD"]);
  assert.ok(plan.values.EMAIL && !("LOGIN_PHONE" in plan.values));
  const f = plan.fields.find((x) => x.name === "LOGIN_PHONE");
  assert.deepStrictEqual(f.options, ["saved", "type", "skip"]);
});

test("planTestData: create option only when the app can create users", () => {
  const plan = td.planTestData({ names: ["LOGIN_PHONE"], canCreate: true });
  assert.ok(plan.fields[0].options.includes("create"));
});

test("planTestData: provided values win; skip yields wrong values", () => {
  const p = td.planTestData({ names: ["LOGIN_PHONE", "LOGIN_PASSWORD"], provided: { LOGIN_PHONE: "0123" }, choices: { LOGIN_PASSWORD: "skip" } });
  assert.strictEqual(p.values.LOGIN_PHONE, "0123");
  assert.strictEqual(p.fields[0].source, "provided");
  assert.strictEqual(p.fields[1].source, "negative-only");
  assert.match(p.values.LOGIN_PASSWORD, /^Wrong-/);
  assert.strictEqual(p.ready, true);
});

test("planTestData: upload mode without fill asks for the gaps", () => {
  const p = td.planTestData({ names: ["EMAIL", "CITY"], mode: "upload", fill: false, provided: { EMAIL: "a@b.c" } });
  assert.deepStrictEqual(p.needsYou, ["CITY"]);
  const q = td.planTestData({ names: ["EMAIL", "CITY"], mode: "upload", provided: { EMAIL: "a@b.c" } });
  assert.strictEqual(q.ready, true);
});

test("describePlan masks secrets, including generated ones", () => {
  const p = td.planTestData({ names: ["NEW_USER_PASSWORD", "EMAIL", "LOGIN_PASSWORD"], provided: { LOGIN_PASSWORD: "hunter2" } });
  const d = td.describePlan(p);
  const text = JSON.stringify(d);
  assert.ok(!text.includes("hunter2"));
  assert.ok(!text.includes(p.values.NEW_USER_PASSWORD));
  assert.ok(text.includes(p.values.EMAIL));
});

test("parseUploaded: JSON, name/value list, CSV row, CSV name/value", () => {
  assert.deepStrictEqual(td.parseUploaded('{"A":"1","B":2}'), { A: "1", B: "2" });
  assert.deepStrictEqual(td.parseUploaded('[{"name":"A","value":"1"}]'), { A: "1" });
  assert.deepStrictEqual(td.parseUploaded("A,B\n1,\"x,y\"\n"), { A: "1", B: "x,y" });
  assert.deepStrictEqual(td.parseUploaded("Name,Value\nA,1\nB,2"), { A: "1", B: "2" });
  assert.deepStrictEqual(td.parseUploaded("﻿A,B\r\n1,2\r\n"), { A: "1", B: "2" });
});

test("parseUploaded: plain errors", () => {
  assert.throws(() => td.parseUploaded(""), /empty/);
  assert.throws(() => td.parseUploaded("{bad"), /JSON/);
  assert.throws(() => td.parseUploaded("A,B"), /header row/);
});

test("checkUpload lists unused and missing names", () => {
  assert.deepStrictEqual(td.checkUpload({ A: "1", Z: "9", B: "" }, ["A", "B", "C"]), { unused: ["Z"], missing: ["B", "C"] });
});

test("toFile never writes secrets; fromFile repeats the same data", () => {
  const names = ["EMAIL", "NEW_USER_PASSWORD", "LOGIN_PHONE", "LOGIN_PASSWORD"];
  const plan = td.planTestData({ names, seed: "fix", provided: { LOGIN_PHONE: "0123", LOGIN_PASSWORD: "hunter2" } });
  const file = td.toFile(plan, { choices: {} });
  const text = JSON.stringify(file);
  assert.ok(!text.includes("hunter2"));
  assert.ok(!text.includes(plan.values.NEW_USER_PASSWORD));
  assert.deepStrictEqual(file.mustSupply, ["LOGIN_PASSWORD"]);
  const back = td.fromFile(JSON.parse(text), { provided: { LOGIN_PASSWORD: "hunter2" } });
  assert.deepStrictEqual(back.values, plan.values);
  assert.throws(() => td.fromFile({}), /not a test-data/);
});

test("prepareApiSteps: only flagged steps change; must-exist stays a placeholder", () => {
  const steps = [
    { kind: "api", method: "POST", url: "/signup", generateBody: true, body: { email: "a@b.c", password: "x" }, hints: { PASSWORD: { existing: false } } },
    { kind: "api", method: "POST", url: "/login", body: { u: "${LOGIN_PHONE}" } },
    { kind: "api", method: "POST", url: "/pay", generateBody: true, body: { token: "t", amount: 5 } },
  ];
  const r = td.prepareApiSteps(steps, { seed: "s" });
  assert.match(r.steps[0].body.email, /@example\.com$/);
  assert.ok(r.steps[0].body.password.length >= 14);
  assert.deepStrictEqual(r.steps[1], steps[1]);
  assert.strictEqual(r.steps[2].body.token, "${TOKEN}");
  assert.deepStrictEqual(r.needsYou, ["TOKEN"]);
  assert.ok(!("generateBody" in r.steps[0]));
  assert.deepStrictEqual(td.prepareApiSteps(steps, { seed: "s" }), r);
});

test("negativeApiCases: one case per bad body, expects a 4xx, saves nothing, stops at that step", () => {
  const steps = [
    { kind: "api", method: "POST", url: "/a", body: { k: 1 } },
    { kind: "api", method: "POST", url: "/signup", generateBody: true, negative: true, save: { ID: "$.id" }, instruction: "Sign up", body: { email: "a@b.c" } },
    { kind: "api", method: "GET", url: "/after" },
  ];
  const cases = td.negativeApiCases(steps, { seed: "s" });
  assert.deepStrictEqual(cases.map((c) => c.name), ["Sign up: missing email", "Sign up: wrong type for email", "Sign up: empty email"]);
  const last = cases[0].steps[cases[0].steps.length - 1];
  assert.strictEqual(cases[0].steps.length, 2);
  assert.ok(!("email" in last.body) && !("save" in last));
  assert.ok(last.expect.status.includes(422));
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall testdata tests passed");
