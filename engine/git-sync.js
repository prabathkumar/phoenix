/**
 * Git versioning for test-case JSON (lifecycle stage: "script -> Git").
 *
 * Commits and pushes test-cases/*.json so every change a tester or the
 * "Record this step" fallback makes is versioned and reviewable.
 *
 * Safety rules (enforced here, not left to callers):
 *   - only files directly under <repoDir>/test-cases/ ending in .json;
 *   - NEVER force-pushes, never rewrites history;
 *   - refuses to commit a test case that types a literal secret: a "type"
 *     step whose instruction mentions password/pin/otp/token/secret must
 *     use a "${ENV_VAR}" placeholder, same rule engine/test-case-runner.js
 *     documents for committed files;
 *   - git is invoked with an argv array (no shell), so file names/messages
 *     can't inject commands.
 *
 * Config: TESTOPS_MOBILE_GIT_REMOTE (default "origin"),
 *         TESTOPS_MOBILE_GIT_BRANCH (default: the current branch).
 */
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const SECRET_WORDS = /password|passcode|\bpin\b|\botp\b|token|secret|api[ -]?key/i;
const ENV_PLACEHOLDER = /^\$\{[A-Z0-9_]+\}$/;

function defaultRunGit(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${(stderr || err.message).trim()}`));
      else resolve(stdout.trim());
    });
  });
}

/** Returns an error string if the test case would commit a literal secret, else null. */
function findLiteralSecret(parsed) {
  const steps = Array.isArray(parsed) ? parsed : parsed && parsed.steps;
  if (!Array.isArray(steps)) return null;
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    if (s && s.kind === "type" && typeof s.text === "string" && SECRET_WORDS.test(s.instruction || "") && !ENV_PLACEHOLDER.test(s.text)) {
      return `step ${i} ("${s.instruction}") types a literal value into a secret-looking field -- use a "\${ENV_VAR}" placeholder instead`;
    }
  }
  return null;
}

function resolveTestCaseFiles(repoDir, files) {
  const dir = path.resolve(repoDir, "test-cases");
  const wanted = files && files.length ? files : fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  return wanted.map((f) => {
    const base = path.basename(String(f));
    if (base !== String(f) || !base.endsWith(".json")) throw new Error(`invalid test case file name: ${f}`);
    const abs = path.join(dir, base);
    if (!fs.existsSync(abs)) throw new Error(`test case file not found: ${base}`);
    return { base, rel: path.join("test-cases", base), abs };
  });
}

/**
 * @param {{repoDir: string, files?: string[], message?: string, push?: boolean, runGit?: Function, env?: Object}} opts
 * @returns {Promise<{success: boolean, committed: boolean, pushed: boolean, commit?: string, files: string[], error?: string}>}
 */
async function syncTestCases({ repoDir, files, message, push = true, runGit = defaultRunGit, env = process.env }) {
  let resolved;
  try {
    resolved = resolveTestCaseFiles(repoDir, files);
    for (const f of resolved) {
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(f.abs, "utf8")); } catch (e) { throw new Error(`${f.base} is not valid JSON: ${e.message}`); }
      const secret = findLiteralSecret(parsed);
      if (secret) throw new Error(`${f.base}: ${secret}`);
    }
  } catch (err) {
    return { success: false, committed: false, pushed: false, files: [], error: err.message };
  }

  const names = resolved.map((f) => f.base);
  try {
    await runGit(repoDir, ["add", "--", ...resolved.map((f) => f.rel)]);
    const staged = await runGit(repoDir, ["diff", "--cached", "--name-only", "--", ...resolved.map((f) => f.rel)]);
    if (!staged) return { success: true, committed: false, pushed: false, files: names };

    const msg = message && String(message).trim() ? String(message).trim() : `test-cases: update ${names.join(", ")}`;
    // Commit ONLY the test-case paths, even if the index has other staged changes.
    await runGit(repoDir, ["commit", "-m", msg, "--", ...resolved.map((f) => f.rel)]);
    const commit = await runGit(repoDir, ["rev-parse", "HEAD"]);

    if (!push) return { success: true, committed: true, pushed: false, commit, files: names };
    const remote = env.TESTOPS_MOBILE_GIT_REMOTE || "origin";
    const branch = env.TESTOPS_MOBILE_GIT_BRANCH || (await runGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]));
    await runGit(repoDir, ["push", remote, `HEAD:${branch}`]); // plain push: never --force
    return { success: true, committed: true, pushed: true, commit, files: names };
  } catch (err) {
    return { success: false, committed: false, pushed: false, files: names, error: err.message };
  }
}

/** Version history of one test case file (newest first). */
async function testCaseHistory({ repoDir, file, limit = 20, runGit = defaultRunGit }) {
  const base = path.basename(String(file));
  const out = await runGit(repoDir, ["log", `-n${Math.min(Number(limit) || 20, 200)}`, "--format=%H%x09%an%x09%aI%x09%s", "--", path.join("test-cases", base)]);
  return out ? out.split("\n").map((l) => { const [commit, author, date, subject] = l.split("\t"); return { commit, author, date, subject }; }) : [];
}

module.exports = { syncTestCases, testCaseHistory, findLiteralSecret };
