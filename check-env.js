#!/usr/bin/env node
/**
 * check-env.js -- zero-dependency, zero-cost environment verification for testers.
 *
 * Run this BEFORE docker build / docker run against real BrowserStack devices.
 * It costs nothing (no Docker, no BrowserStack session, no Appium) and tells
 * you exactly which environment variables are MISSING, EMPTY, or SET, so you
 * never burn a real device session just to discover a typo in .env.
 *
 * Usage:
 *   node check-env.js
 *   node check-env.js test-cases/addons.ios.json
 *   node check-env.js --env-file .env test-cases/addons.ios.json
 *
 * Why this exists: Docker's --env-file treats a line like
 *   PHOENIX_BATCH_LOGIN_PASSWORD=
 * as a genuinely empty string, NOT as "unset". A plain `grep VAR .env` or
 * glancing at the file makes an empty value look identical to a correctly
 * set one. This script parses .env the same way Docker does, and reports
 * EMPTY as its own distinct, loudly-flagged state.
 *
 * Never prints actual secret values. Any variable whose name matches
 * /PASSWORD|KEY|SECRET|TOKEN/i is shown only as "SET (hidden)".
 */

const fs = require("fs");
const path = require("path");

const SECRET_NAME_RE = /PASSWORD|KEY|SECRET|TOKEN/i;
// Matches Docker's own ${VAR} step-placeholder convention used in test-case files.
const ENV_PLACEHOLDER_RE = /^\$\{([A-Z0-9_]+)\}$/;

function parseArgs(argv) {
  const args = { envFile: ".env", testCaseFile: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env-file") {
      args.envFile = argv[++i];
    } else {
      rest.push(argv[i]);
    }
  }
  if (rest[0]) args.testCaseFile = rest[0];
  return args;
}

/**
 * Parses a .env file the same way `docker run --env-file` does:
 *   - blank lines and lines starting with # are ignored
 *   - KEY=VALUE sets VALUE (no quote stripping, matching Docker's own
 *     behavior -- Docker does NOT strip quotes either)
 *   - KEY= (nothing after the =) sets an EMPTY STRING, not "unset"
 *   - a line with no "=" at all is ignored (Docker would also reject it,
 *     but we don't want this script to crash on a stray line)
 * Returns a Map<string, string> of exactly what Docker would load.
 */
function parseDotEnv(filePath) {
  const map = new Map();
  if (!fs.existsSync(filePath)) {
    return { map, found: false };
  }
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (!key) continue;
    map.set(key, value);
  }
  return { map, found: true };
}

/**
 * Reads the required env-var names a test-case file depends on, by scanning
 * each step's "text" field for a literal "${VAR_NAME}" placeholder -- the
 * same convention engine/test-case-runner.js's requiredEnvVars() looks for.
 * Done here via plain fs/JSON so this script has zero project dependencies
 * and works even if node_modules was never installed.
 */
function requiredEnvVarsFromTestCase(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const json = JSON.parse(raw);
  const steps = Array.isArray(json.steps) ? json.steps : [];
  const names = new Set();
  for (const step of steps) {
    if (typeof step.text !== "string") continue;
    const match = ENV_PLACEHOLDER_RE.exec(step.text);
    if (match) names.add(match[1]);
  }
  return [...names];
}

function displayValue(name, value) {
  if (SECRET_NAME_RE.test(name)) return "SET (hidden)";
  return `SET (${JSON.stringify(value)})`;
}

function checkVar(name, envMap, { optional = false } = {}) {
  // Docker env-file values win; but a var can also be supplied via
  // `-e NAME=...` or the shell's own exported environment, so check
  // process.env too -- this mirrors how the real docker run command
  // layers --env-file UNDER explicit -e / shell-exported values.
  const inDotEnv = envMap.has(name);
  const inProcess = Object.prototype.hasOwnProperty.call(process.env, name);

  let value;
  let source;
  if (inProcess) {
    value = process.env[name];
    source = "shell/exported env";
  } else if (inDotEnv) {
    value = envMap.get(name);
    source = ".env file";
  } else {
    return { name, status: "MISSING", optional };
  }

  if (value === "") {
    return { name, status: "EMPTY", source, optional };
  }
  return { name, status: "SET", source, optional, display: displayValue(name, value) };
}

function printResult(result) {
  const pad = result.name.padEnd(34);
  if (result.status === "MISSING") {
    console.log(`  [MISSING] ${pad} -- not set anywhere (not in .env, not exported)`);
  } else if (result.status === "EMPTY") {
    console.log(`  [EMPTY!!] ${pad} -- present in ${result.source} but has NO VALUE after "="`);
  } else {
    console.log(`  [OK]      ${pad} -- ${result.display}  (from ${result.source})`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const envPath = path.resolve(process.cwd(), args.envFile);

  console.log(`Phoenix env check`);
  console.log(`==================`);
  console.log(`Reading: ${envPath}`);

  const { map: envMap, found } = parseDotEnv(envPath);
  if (!found) {
    console.log(`\n[MISSING FILE] ${args.envFile} does not exist in this directory.`);
    console.log(`               Either create it, or pass --env-file <path>.`);
  } else {
    console.log(`Found ${envMap.size} key(s) in ${args.envFile}.\n`);
  }

  const problems = [];
  const record = (r) => {
    printResult(r);
    if ((r.status === "MISSING" || r.status === "EMPTY") && !r.optional) {
      problems.push(r);
    }
  };

  console.log(`\n-- Appium provider --`);
  const providerResult = checkVar("PHOENIX_APPIUM_PROVIDER", envMap, { optional: true });
  record(providerResult);
  const providerValue =
    providerResult.status === "SET"
      ? process.env.PHOENIX_APPIUM_PROVIDER ?? envMap.get("PHOENIX_APPIUM_PROVIDER")
      : null;

  if (providerValue !== "browserstack") {
    console.log(
      `  NOTE: PHOENIX_APPIUM_PROVIDER is ${
        providerValue ? `"${providerValue}"` : "not set"
      }, not "browserstack" -- a run will try a local Appium server/emulator instead of real BrowserStack devices.`
    );
  } else {
    console.log(`\n-- BrowserStack credentials (required because PHOENIX_APPIUM_PROVIDER=browserstack) --`);
    for (const name of ["PHOENIX_BROWSERSTACK_USER", "PHOENIX_BROWSERSTACK_KEY", "PHOENIX_BROWSERSTACK_APP_URL"]) {
      record(checkVar(name, envMap));
    }
  }

  if (args.testCaseFile) {
    console.log(`\n-- Variables required by test case: ${args.testCaseFile} --`);
    let required;
    try {
      required = requiredEnvVarsFromTestCase(path.resolve(process.cwd(), args.testCaseFile));
    } catch (err) {
      console.log(`  [ERROR] couldn't read/parse that test case file: ${err.message}`);
      required = null;
    }
    if (required) {
      if (required.length === 0) {
        console.log(`  (this test case has no \${VAR} placeholders -- nothing required here)`);
      }
      for (const name of required) {
        record(checkVar(name, envMap));
      }
    }
  } else {
    console.log(
      `\n(no test-case file given -- pass one, e.g. "node check-env.js test-cases/addons.ios.json", ` +
        `to also check that file's own required variables)`
    );
  }

  console.log(`\n==================`);
  if (problems.length === 0) {
    console.log(`All checked variables look good. Safe to proceed with a real run.`);
    process.exit(0);
  } else {
    console.log(`${problems.length} problem(s) found -- fix these before spending a real BrowserStack session:`);
    for (const p of problems) {
      if (p.status === "MISSING") {
        console.log(`  - ${p.name} is not set. Add a line "${p.name}=<value>" to ${args.envFile}.`);
      } else {
        console.log(
          `  - ${p.name} is present in ${p.source} but EMPTY (the line is "${p.name}=" with nothing after it). ` +
            `Edit ${args.envFile} and put the real value after the "=".`
        );
      }
    }
    process.exit(1);
  }
}

main();
