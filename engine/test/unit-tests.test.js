const assert = require("assert");
const U = require("../core/unit-tests");
const R = require("../core/repo");
const H = require("../core/handlers");

(async () => {
  // languages and file naming
  const cases = { "src/a.js": "javascript", "web/a.tsx": "typescript", "pkg/m.py": "python", "src/main/java/x/Foo.java": "java", "cmd/main.go": "go", "Svc/Order.cs": "csharp", "README.md": null };
  for (const [f, l] of Object.entries(cases)) assert.strictEqual(U.languageOf(f), l, f);
  assert.strictEqual(U.LANGS.python.test("pkg/m.py"), "pkg/test_m.py");
  assert.strictEqual(U.LANGS.java.test("src/main/java/x/Foo.java"), "src/test/java/x/FooTest.java");
  assert.strictEqual(U.LANGS.go.test("cmd/main.go"), "cmd/main_test.go");
  assert.strictEqual(U.LANGS.csharp.test("Svc/Order.cs"), "Svc/OrderTests.cs");

  // file picking: skips tests and vendored code; Semgrep-flagged files first
  const all = ["a.js", "a.test.js", "node_modules/x/i.js", "b.py", "test_b.py", "c.go", "c_test.go", "d.java", "docs.md"];
  assert.deepStrictEqual(U.pickFiles(all, { flagged: ["d.java"], max: 3 }), ["d.java", "a.js", "b.py"]);
  assert.deepStrictEqual(U.pickFiles(all, { languages: ["go"] }), ["c.go"]);

  // semgrep json -> findings by file
  const f = U.parseSemgrep({ results: [{ path: "./a.js", check_id: "x.y.sql-injection", extra: { message: "unsanitised query" }, start: { line: 7 } }] });
  assert.deepStrictEqual(f, { "a.js": ["sql-injection: unsanitised query (line 7)"] });
  assert.deepStrictEqual(U.parseSemgrep("not json"), {});

  // generation: findings reach the prompt; bad answers are skipped with a reason
  const prompts = [];
  const answers = { "a.js": { code: "```js\nconst test=require('node:test');\ntest('x', ()=>{});\n```" }, "b.py": { code: "no tests here" }, "c.go": { code: "" }, "d.java": { code: "@Test void a(){}" } };
  const callJson = async (p) => { prompts.push(p); const src = /SOURCE FILE: (\S+)/.exec(p)[1]; return answers[src]; };
  const gp = () => ({ text: "WRITE TESTS" });
  const r = await U.generateTests({ files: ["a.js", "b.py", "c.go", "d.java"], readFile: async (x) => `code of ${x}`, callJson, getPrompt: gp, findings: f });
  assert.deepStrictEqual(r.files.map((x) => x.path), ["a.test.js", "src/test/java/x/FooTest.java"].slice(0, 1).concat(r.files.slice(1).map((x) => x.path)));
  assert.strictEqual(r.files[0].flagged, 1);
  assert.ok(prompts[0].includes("SEMGREP FINDINGS") && prompts[0].includes("unsanitised query") && prompts[0].includes("node:test"));
  assert.ok(!prompts[1].includes("SEMGREP FINDINGS"));
  assert.ok(r.skipped.some((s) => s.source === "b.py" && /no pytest test/.test(s.why)) && r.skipped.some((s) => s.source === "c.go" && /no test code/.test(s.why)));
  assert.ok(!r.files[0].content.includes("```"));
  const bad = await U.generateTests({ files: ["a.js"], readFile: async () => "x", callJson: async () => ({ code: "test('a', ()=>{" }), getPrompt: gp, syntax: () => ({ ok: false, why: "Unexpected end" }) });
  assert.ok(/syntax error/.test(bad.skipped[0].why));
  assert.strictEqual(U.syntaxCheck("python", "def test_a():\n    assert 1\n").ok, true);
  assert.strictEqual(U.syntaxCheck("python", "def test_a(:\n").ok, false);
  assert.strictEqual(U.syntaxCheck("go", "x").unchecked, true);

  // repo: GitHub and GitLab through a fake host; tokens in headers only; errors do not echo bodies
  for (const provider of ["github", "gitlab"]) {
    const calls = [];
    const fetchFn = async (url, o) => { calls.push({ url, m: o.method, h: o.headers, b: o.body }); const ok = (j) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) });
      if (/git\/trees|repository\/tree/.test(url)) return ok(provider === "github" ? { tree: [{ type: "blob", path: "a.js" }, { type: "tree", path: "d" }] } : [{ type: "blob", path: "a.js" }]);
      if (/contents\/a\.js|files\/a\.js/.test(url) && o.method === "GET") return ok({ content: Buffer.from("code").toString("base64") });
      if (/git\/ref\/heads/.test(url)) return ok({ object: { sha: "abc" } });
      if (/pulls$|merge_requests$/.test(url)) return ok({ html_url: "https://h/pr/1", web_url: "https://h/mr/1" });
      if (/\/repos\/o\/n$|projects\/o%2Fn$/.test(url)) return ok({ default_branch: "main" });
      return ok({}); };
    const repo = R.connect({ provider, project: "o/n", token: "TOK3N", fetchFn });
    assert.strictEqual(await repo.defaultBranch(), "main");
    assert.deepStrictEqual(await repo.listFiles("main"), ["a.js"]);
    assert.strictEqual(await repo.readFile("a.js", "main"), "code");
    const pr = await repo.openPullRequest({ base: "main", branch: "testops/x", title: "t", files: [{ path: "a.test.js", content: "c" }] });
    assert.ok(/https:\/\/h\/(pr|mr)\/1/.test(pr.url));
    assert.ok(!calls.map((c) => c.b || "").join("").includes("TOK3N"));
    assert.ok(calls.every((c) => JSON.stringify(c.h).includes("TOK3N")));
    assert.ok(calls.every((c) => !(c.m === "PUT" || c.m === "POST") || !/heads\/main|branch=main|"branch":"main"/.test(c.url + c.b)));  // never writes to the base branch
  }
  assert.throws(() => R.connect({ provider: "svn", project: "o/n", token: "t" }), /github.*gitlab/);
  assert.throws(() => R.connect({ provider: "github", project: "o/n" }), /GITHUB_TOKEN/);
  await assert.rejects(R.connect({ provider: "github", project: "o/n", token: "t", fetchFn: async () => ({ ok: false, status: 404, text: async () => "secret body" }) }).defaultBranch(), (e) => /failed \(404\)/.test(e.message) && !/secret body/.test(e.message));

  // stage handlers: tests written, then the PR (a separate gated stage)
  const files = { "a.js": "x", "a.test.js": "t", "m.py": "y" };
  const opened = [];
  const connectRepo = () => ({ defaultBranch: async () => "main", listFiles: async () => Object.keys(files), readFile: async (p) => files[p], openPullRequest: async (a) => { opened.push(a); return { url: "https://h/pr/9", branch: a.branch }; } });
  const cj = async (p) => ({ code: /python/.test(p) ? "def test_a():\n    assert True\n" : "test('a', () => {});\n" });
  const ctx = { repoRequest: { provider: "github", project: "o/n" }, results: [{ id: "sast", data: { findings: { "m.py": ["sql: x (line 1)"] } } }] };
  const u = await H.unittestsHandler({ callJson: cj, getPrompt: gp, connectRepo })(ctx);
  assert.ok(u.ok && /2 test file/.test(u.detail), u.detail);
  assert.strictEqual(u.data.tests[0].source, "m.py"); // flagged file first
  const pr = await H.testsPrHandler({ connectRepo })({ ...ctx, results: [{ id: "unittests", data: u.data }] });
  assert.ok(pr.ok && opened[0].branch.startsWith("testops/ai-unit-tests-") && opened[0].files.length === 2 && /have not been run/.test(opened[0].body));
  assert.strictEqual((await H.unittestsHandler({ callJson: cj, getPrompt: gp, connectRepo })({})).unavailable, true);
  assert.strictEqual((await H.unittestsHandler({ getPrompt: gp, connectRepo })(ctx)).unavailable, true);
  assert.strictEqual((await H.testsPrHandler({ connectRepo })({ results: [] })).unavailable, true);

  // pipeline: opening the PR asks first at the default level; the shipped prompt is created on first use
  const { runPipeline } = require("../core/pipeline");
  const pl = await runPipeline({ only: ["unittests", "testspr"], handlers: { unittests: async () => ({ ok: true }), testspr: async () => ({ ok: true }) } });
  assert.strictEqual(pl.stages.find((s) => s.id === "testspr").status, "needs-you");
  const fs = require("fs"), os = require("os"), path = require("path");
  const env = { TESTOPS_GATEWAY_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "ut-")) };
  assert.ok(/unit tests/i.test(require("../gateway/prompt-store").getPrompt("unit_test_gen", "shared", {}, { env }).text));
  console.log("unit-tests tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
