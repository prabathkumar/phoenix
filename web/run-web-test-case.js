#!/usr/bin/env node
/**
 * CLI: run a test-case JSON on the web via Playwright; exit code 0 = pass, 1 = fail.
 *
 *   node web/run-web-test-case.js test-cases/web-example.json --base-url http://localhost:3000 [--headed] [--persist] [--out result.json]
 *
 * Prints the shared pass/fail contract (engine/test-result.js) as JSON.
 * --persist writes newly proven selectors back into the test-case file.
 *
 * The ladder (Synthetic -> Semantic -> AI -> Guided) runs when a recorded locator fails:
 *   --ai          allow the AI goal loop when Semantic cannot resolve the step
 *   --no-vision   do not send screenshots to the model (text-only Semantic)
 *   --ask         when everything else fails, ask YOU at the terminal for a locator
 *                 (css:#id | text:Sign in | label:Email | testid:x | role:button:Sign in | skip)
 * Fixes found by a lower layer come back as PATCHES: shown after the run, and with
 * --persist the evidence-backed ones are written into the file (never silently).
 */
const fs = require("fs");
const { runWebTestCase } = require("./web-test-case-runner");
const { persistResolvedSelectors } = require("../engine/test-case-runner");

/** "role:button:Sign in" | "css:#x" | "text:..." -> selector object, or null. */
function parseSelector(text) {
  const t = String(text || "").trim();
  const m = t.match(/^(css|text|label|testid|xpath|role):(.*)$/s);
  if (!m) return null;
  if (m[1] === "role") { const r = m[2].match(/^([^:]+):(.*)$/s); return r ? { strategy: "role", role: r[1], value: r[2], exact: true } : null; }
  return { strategy: m[1], value: m[2] };
}

function askAtTerminal({ index, step, reason }) {
  const rl = require("readline").createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`\n[guided] step ${index + 1} "${step.instruction}" could not be done.\n  ${reason}\n  Give a locator (css:#id | text:Sign in | label:Email | testid:x | role:button:Sign in), or "skip": `, (answer) => {
      rl.close();
      if (/^skip$/i.test(answer.trim())) return resolve({ skip: true });
      resolve({ selector: parseSelector(answer) });
    });
  });
}

(async () => {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith("--"));
  const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  if (!file) { console.error("usage: run-web-test-case.js <test-case.json> [--base-url URL] [--headed] [--browserstack] [--persist] [--out file]"); process.exit(2); }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const steps = Array.isArray(parsed) ? parsed : parsed.steps;
  const result = await runWebTestCase(steps, {
    baseUrl: opt("base-url") || parsed.baseUrl,
    headless: !argv.includes("--headed"),
    testCase: parsed.name || file,
    runOn: argv.includes("--browserstack") ? "browserstack" : "local",
    recordedOn: Array.isArray(parsed) ? undefined : parsed.recordedOn,
    contextOptions: {},
    testData: parsed.testData,
    ai: argv.includes("--ai"),
    vision: !argv.includes("--no-vision"),
    onGuided: argv.includes("--ask") ? askAtTerminal : undefined,
  });
  if (result.patches && result.patches.length) {
    console.error("\n[ladder] fixes found by a lower layer (proposed, not applied unless --persist):");
    result.patches.forEach((p) => console.error(`  step ${p.index + 1} "${p.instruction}": ${p.layer} ${p.promotable ? "- ready to promote" : "- NOT promotable (fragile or no evidence)"}`));
  }
  if (argv.includes("--persist") && result.success) persistResolvedSelectors(file, result.updatedSteps);
  if (argv.includes("--persist") && result.success && result.patches && result.patches.some((p) => p.promotable)) {
    const next = Array.isArray(parsed) ? result.healedSteps : { ...parsed, steps: result.healedSteps };
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
    console.error(`[ladder] promoted ${result.patches.filter((p) => p.promotable).length} fix(es) into ${file}`);
  }
  const { updatedSteps, healedSteps, ...report } = result;
  const text = JSON.stringify(report, null, 2);
  if (opt("out")) fs.writeFileSync(opt("out"), text + "\n"); else console.log(text);
  console.error(`[web] ${report.status.toUpperCase()}: ${report.detail}`);
  process.exit(report.success ? 0 : 1);
})().catch((e) => { console.error("[web] fatal:", e.message); process.exit(1); });
