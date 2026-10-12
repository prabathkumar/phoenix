#!/usr/bin/env node
/**
 * CLI: give the AI layer a goal and a start URL; it drives a browser toward it
 * and prints the steps it took (as a test case you can save and replay).
 *
 *   node web/run-web-loop.js "sign in and open the dashboard" --url https://example.com [--headed]
 *        [--max-steps 12] [--no-vision] [--out flow.json]
 *
 * Needs the local model (Ollama, see docs/SETUP.md). The loop stops for a person
 * before anything that looks irreversible (pay, delete, ...) and never leaves the
 * start site. Exit code 0 = goal reached.
 */
const fs = require("fs");
const { createPlaywrightSurface } = require("./surface/playwright-surface");
const { runGoalLoop } = require("../engine/core/goal-loop");

(async () => {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const goal = argv[0] && !argv[0].startsWith("--") ? argv[0] : undefined;
  const url = opt("url");
  if (!goal || !url) { console.error('usage: run-web-loop.js "<goal>" --url <start url> [--headed] [--max-steps N] [--no-vision] [--out file.json]'); process.exit(2); }
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: !argv.includes("--headed"), executablePath: process.env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    const surface = createPlaywrightSurface(page);
    const result = await runGoalLoop(surface, goal, {
      vision: !argv.includes("--no-vision"),
      maxSteps: Number(opt("max-steps")) || 12,
      onProgress: (p) => console.error(`[loop] ${p.step}. ${p.message}`),
    });
    const testCase = { name: goal, baseUrl: new URL(url).origin, steps: [{ kind: "navigate", instruction: `Open ${url}`, url }, ...result.steps.map((s) => s.step)] };
    const out = { success: result.success, reason: result.reason, testCase };
    if (opt("out")) fs.writeFileSync(opt("out"), JSON.stringify(testCase, null, 2) + "\n"); else console.log(JSON.stringify(out, null, 2));
    console.error(`[loop] ${result.success ? "GOAL REACHED" : "NOT REACHED"}: ${result.reason}`);
    process.exit(result.success ? 0 : 1);
  } finally { await browser.close(); }
})().catch((e) => { console.error("[loop] fatal:", e.message); process.exit(1); });
