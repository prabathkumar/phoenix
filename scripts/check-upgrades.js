#!/usr/bin/env node
/**
 * Upgrade check for the two engines TestOps ai-automate sits on top of:
 * Playwright (web) and Appium + WebdriverIO + its drivers (mobile).
 *
 *   node scripts/check-upgrades.js          report only
 *   node scripts/check-upgrades.js --strict exit 1 when something is behind
 *
 * What it does: for each pinned dependency it prints the range in package.json,
 * the version actually installed, and the latest published one. After ANY bump,
 * run the upgrade routine in docs/UPGRADING.md (suite + real-browser tests +
 * one BrowserStack smoke) before merging.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const WATCH = [
  ["web", "playwright"],
  ["engine", "webdriverio"],
  ["engine", "appium"],
  ["engine", "appium-uiautomator2-driver"],
];

function installed(dir, name) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "..", dir, "node_modules", name, "package.json"), "utf8")).version; }
  catch { return "not installed"; }
}
function latest(name) {
  try { return execFileSync("npm", ["view", name, "version"], { encoding: "utf8", timeout: 20000 }).trim(); }
  catch { return "unknown (npm registry unreachable)"; }
}
const major = (v) => Number(String(v).split(".")[0]);

let behind = 0;
console.log("package".padEnd(30), "range".padEnd(10), "installed".padEnd(14), "latest");
for (const [dir, name] of WATCH) {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", dir, "package.json"), "utf8"));
  const range = (pkg.dependencies || {})[name] || (pkg.devDependencies || {})[name] || "-";
  const inst = installed(dir, name);
  const last = latest(name);
  const stale = /^\d/.test(last) && /^\d/.test(inst) && inst !== last;
  const crossMajor = stale && major(last) > major(inst);
  if (stale) behind += 1;
  console.log(name.padEnd(30), range.padEnd(10), inst.padEnd(14), last + (crossMajor ? "   <- MAJOR upgrade: read the changelog" : stale ? "   <- update available" : ""));
}
console.log(behind ? `\n${behind} package(s) behind. See docs/UPGRADING.md for the routine.` : "\nAll watched engines are current.");
if (behind && process.argv.includes("--strict")) process.exit(1);
