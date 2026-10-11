const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { syncTestCases, testCaseHistory, findLiteralSecret } = require("../git-sync");

async function test(name, fn) { await fn(); console.log(`  ok - ${name}`); }
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const roots = [];

function makeRepos() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tm-gitsync-"));
  roots.push(root);
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", work], { stdio: "ignore" });
  git(work, "config", "user.email", "t@t"); git(work, "config", "user.name", "T");
  git(work, "remote", "add", "origin", remote);
  fs.mkdirSync(path.join(work, "test-cases"));
  fs.writeFileSync(path.join(work, "README"), "x");
  git(work, "add", "."); git(work, "commit", "-m", "init"); git(work, "push", "origin", "main");
  return { root, remote, work };
}
const tc = (steps) => JSON.stringify({ name: "t", steps }, null, 2);

(async () => {
  await test("findLiteralSecret flags a literal password, allows ${ENV} placeholders", () => {
    assert.match(findLiteralSecret({ steps: [{ kind: "type", instruction: "type the password", text: "hunter2" }] }), /step 0/);
    assert.strictEqual(findLiteralSecret({ steps: [{ kind: "type", instruction: "type the password", text: "${LOGIN_PW}" }] }), null);
    assert.strictEqual(findLiteralSecret({ steps: [{ kind: "type", instruction: "type the city", text: "Paris" }] }), null);
  });

  await test("commits + pushes a changed test case; remote receives it; history lists it", async () => {
    const { remote, work } = makeRepos();
    fs.writeFileSync(path.join(work, "test-cases", "a.json"), tc([{ kind: "tap", instruction: "tap x" }]));
    const r = await syncTestCases({ repoDir: work, files: ["a.json"], message: "add a" });
    assert.deepStrictEqual([r.success, r.committed, r.pushed], [true, true, true]);
    assert.strictEqual(git(remote, "log", "-1", "--format=%s", "main"), "add a");
    const h = await testCaseHistory({ repoDir: work, file: "a.json" });
    assert.strictEqual(h.length, 1);
    assert.strictEqual(h[0].subject, "add a");
  });

  await test("nothing changed -> success, no commit, no push", async () => {
    const { work } = makeRepos();
    fs.writeFileSync(path.join(work, "test-cases", "a.json"), tc([{ kind: "tap", instruction: "tap x" }]));
    await syncTestCases({ repoDir: work, files: ["a.json"] });
    const again = await syncTestCases({ repoDir: work, files: ["a.json"] });
    assert.deepStrictEqual([again.success, again.committed, again.pushed], [true, false, false]);
  });

  await test("a literal secret is refused BEFORE anything is staged or committed", async () => {
    const { work } = makeRepos();
    fs.writeFileSync(path.join(work, "test-cases", "bad.json"), tc([{ kind: "type", instruction: "type the password", text: "hunter2" }]));
    const before = git(work, "rev-parse", "HEAD");
    const r = await syncTestCases({ repoDir: work, files: ["bad.json"] });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /literal|placeholder/);
    assert.strictEqual(git(work, "rev-parse", "HEAD"), before);
    assert.strictEqual(git(work, "diff", "--cached", "--name-only"), "");
  });

  await test("path traversal / non-json names are rejected", async () => {
    const { work } = makeRepos();
    for (const f of ["../README", "a/b.json", "x.txt"]) {
      const r = await syncTestCases({ repoDir: work, files: [f] });
      assert.strictEqual(r.success, false, f);
    }
  });

  await test("only the test-case files are committed even if other changes are staged", async () => {
    const { work } = makeRepos();
    fs.writeFileSync(path.join(work, "other.txt"), "unrelated"); git(work, "add", "other.txt");
    fs.writeFileSync(path.join(work, "test-cases", "a.json"), tc([{ kind: "tap", instruction: "tap x" }]));
    await syncTestCases({ repoDir: work, files: ["a.json"], push: false });
    assert.strictEqual(git(work, "show", "--name-only", "--format=", "HEAD"), "test-cases/a.json");
    assert.strictEqual(git(work, "diff", "--cached", "--name-only"), "other.txt");
  });

  await test("a rejected push (remote moved ahead) reports failure and never force-pushes", async () => {
    const { remote, work, root } = makeRepos();
    const other = path.join(root, "other");
    execFileSync("git", ["clone", remote, other], { stdio: "ignore" });
    git(other, "config", "user.email", "o@o"); git(other, "config", "user.name", "O");
    fs.writeFileSync(path.join(other, "z"), "z"); git(other, "add", "."); git(other, "commit", "-m", "remote moved"); git(other, "push", "origin", "main");
    fs.writeFileSync(path.join(work, "test-cases", "a.json"), tc([{ kind: "tap", instruction: "tap x" }]));
    const r = await syncTestCases({ repoDir: work, files: ["a.json"] });
    assert.strictEqual(r.success, false);
    assert.strictEqual(git(remote, "log", "-1", "--format=%s", "main"), "remote moved");
  });
  roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true }));
  console.log("\ngit-sync tests passed");
})();
