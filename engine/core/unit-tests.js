/**
 * AI-written unit tests for several languages, wired to the repo and to Semgrep.
 *   Languages: JavaScript, TypeScript, Python, Java, Go, C#  (framework and file name follow each language's convention)
 *   Flow: pick source files (changed or named, or the ones Semgrep flagged first) -> model writes the test file
 *         (prompt "unit_test_gen" from the prompt library) -> checks -> files ready to commit as a pull/merge request.
 *   Semgrep: findings for a file go into the prompt, so the tests include a case that fails while the flagged code is
 *            still vulnerable. Files Semgrep flagged are tested first.
 * Checks: not empty, right language shape, no secrets (the gateway already redacts), and a real syntax check where the
 * toolchain is installed (node, python). Nothing here runs the generated tests; the repo's CI does, on the pull request.
 */
const path = require("path");
const { spawnSync } = require("child_process");

const LANGS = {
  javascript: { ext: [".js", ".mjs", ".cjs"], framework: "node:test with node:assert", test: (f) => f.replace(/\.(m|c)?js$/, ".test.js"), run: "node --test" },
  typescript: { ext: [".ts", ".tsx"], framework: "Vitest (import { describe, it, expect } from 'vitest')", test: (f) => f.replace(/\.tsx?$/, ".test.ts"), run: "npx vitest run" },
  python: { ext: [".py"], framework: "pytest", test: (f) => path.posix.join(path.posix.dirname(f), "test_" + path.posix.basename(f)), run: "pytest" },
  java: { ext: [".java"], framework: "JUnit 5 (org.junit.jupiter)", test: (f) => f.replace(/(^|\/)src\/main\//, "$1src/test/").replace(/\.java$/, "Test.java"), run: "mvn test" },
  go: { ext: [".go"], framework: "the standard testing package", test: (f) => f.replace(/\.go$/, "_test.go"), run: "go test ./..." },
  csharp: { ext: [".cs"], framework: "xUnit", test: (f) => f.replace(/\.cs$/, "Tests.cs"), run: "dotnet test" },
};
const IGNORE = /(^|\/)(node_modules|vendor|dist|build|target|bin|obj|\.git|generated)\//;
const isTest = (f) => /(\.test\.|\.spec\.|_test\.|(^|\/)test_|Tests?\.(java|cs)$|(^|\/)(tests?|__tests__)\/)/i.test(f);
function languageOf(file) { const e = path.posix.extname(file).toLowerCase(); return Object.keys(LANGS).find((k) => LANGS[k].ext.includes(e)) || null; }

/** Source files worth testing: known language, not already a test, not vendored. Flagged files first, then the rest. */
function pickFiles(all, { only, flagged = [], max = 5, languages } = {}) {
  const ok = (f) => languageOf(f) && !isTest(f) && !IGNORE.test(f) && (!languages || languages.includes(languageOf(f)));
  const pool = (only && only.length ? only : all).filter(ok);
  const first = pool.filter((f) => flagged.includes(f)), rest = pool.filter((f) => !flagged.includes(f));
  return [...first, ...rest].slice(0, max);
}

/** Semgrep --json output -> { "path": [ "rule: message (line N)" ] }. */
function parseSemgrep(json) {
  let j; try { j = typeof json === "string" ? JSON.parse(json) : json; } catch { return {}; }
  const out = {};
  for (const r of (j && j.results) || []) { const f = String(r.path || "").replace(/^\.\//, ""); (out[f] = out[f] || []).push(`${String(r.check_id || "").split(".").pop()}: ${String((r.extra || {}).message || "").slice(0, 200)} (line ${(r.start || {}).line || "?"})`); }
  return out;
}

function syntaxCheck(lang, code, exec = (c, a, o) => spawnSync(c, a, { encoding: "utf8", input: o && o.input, timeout: 20000 })) {
  try {
    if (lang === "javascript") { const r = exec("node", ["--check", "--input-type=module", "-"], { input: code }); return r.status === 0 || /require is not defined|Cannot use import/.test(String(r.stderr)) ? { ok: true } : { ok: false, why: String(r.stderr).split("\n")[0] }; }
    if (lang === "python") { const r = exec("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], { input: code }); return r.status === 0 ? { ok: true } : { ok: false, why: String(r.stderr).trim().split("\n").pop() }; }
  } catch { /* toolchain missing */ }
  return { ok: true, unchecked: true };
}

const SHAPE = { javascript: /\b(test|it|describe)\s*\(/, typescript: /\b(test|it|describe)\s*\(/, python: /\bdef test_/, java: /@Test\b/, go: /func Test\w+\(t \*testing\.T\)/, csharp: /\[(Fact|Theory)\]/ };
const stripFence = (s) => String(s || "").replace(/^\s*```[\w+-]*\n?/, "").replace(/\n?```\s*$/, "");

/**
 * @returns {Promise<{files:[{path, source, language, content, flagged, checks}], skipped:[{source, why}]}>}
 */
async function generateTests({ files, readFile, callJson, getPrompt, findings = {}, syntax = syntaxCheck }) {
  const out = [], skipped = [];
  for (const source of files) {
    const lang = languageOf(source), L = LANGS[lang];
    try {
      const code = await readFile(source);
      if (String(code).length > 40000) { skipped.push({ source, why: "file is too large to test in one go" }); continue; }
      const { text } = getPrompt("unit_test_gen", "shared");
      const flagged = findings[source] || [];
      const r = await callJson(`${text}\n\nLANGUAGE: ${lang}\nFRAMEWORK: ${L.framework}\nSOURCE FILE: ${source}\nTEST FILE: ${L.test(source)}\n` +
        (flagged.length ? `SEMGREP FINDINGS IN THIS FILE (include a test that fails while this code is still vulnerable):\n- ${flagged.join("\n- ")}\n` : "") + `\nSOURCE:\n${code}`);
      const body = stripFence(typeof r === "string" ? r : r && (r.code || r.test || r.content));
      if (!body.trim()) { skipped.push({ source, why: "the model returned no test code" }); continue; }
      if (!SHAPE[lang].test(body)) { skipped.push({ source, why: `the answer has no ${L.framework} test in it` }); continue; }
      const sx = syntax(lang, body);
      if (!sx.ok) { skipped.push({ source, why: `syntax error: ${sx.why}` }); continue; }
      out.push({ path: L.test(source), source, language: lang, content: body.endsWith("\n") ? body : body + "\n", flagged: flagged.length, checks: { syntax: sx.unchecked ? "not checked (no toolchain here)" : "ok" } });
    } catch (e) { skipped.push({ source, why: e.message }); }
  }
  return { files: out, skipped };
}
module.exports = { LANGS, languageOf, pickFiles, parseSemgrep, generateTests, syntaxCheck, isTest };
