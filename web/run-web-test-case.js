#!/usr/bin/env node
/**
 * CLI: run a test-case JSON on the web via Playwright; exit code 0 = pass, 1 = fail.
 *
 *   node web/run-web-test-case.js test-cases/web-example.json --base-url http://localhost:3000 [--headed] [--persist] [--out result.json]
 *
 * Prints the shared pass/fail contract (engine/test-result.js) as JSON.
 * --persist writes newly proven selectors back into the test-case file.
 */
const fs = require("fs");
const { runWebTestCase } = require("./web-test-case-runner");
const { persistResolvedSelectors } = require("../engine/test-case-runner");

(async () => {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith("--"));
  const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  if (!file) { console.error("usage: run-web-test-case.js <test-case.json> [--base-url URL] [--headed] [--persist] [--out file]"); process.exit(2); }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const steps = Array.isArray(parsed) ? parsed : parsed.steps;
  const result = await runWebTestCase(steps, {
    baseUrl: opt("base-url") || parsed.baseUrl,
    headless: !argv.includes("--headed"),
    testCase: parsed.name || file,
    contextOptions: {},
  });
  if (argv.includes("--persist") && result.success) persistResolvedSelectors(file, result.updatedSteps);
  const { updatedSteps, ...report } = result;
  const text = JSON.stringify(report, null, 2);
  if (opt("out")) fs.writeFileSync(opt("out"), text + "\n"); else console.log(text);
  console.error(`[web] ${report.status.toUpperCase()}: ${report.detail}`);
  process.exit(report.success ? 0 : 1);
})().catch((e) => { console.error("[web] fatal:", e.message); process.exit(1); });
