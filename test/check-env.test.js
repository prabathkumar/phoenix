/**
 * Tests for check-env.js -- the zero-cost pre-flight env checker.
 *
 * This is pure file-parsing logic with no network/device dependency, so
 * unlike vision fusion (see docs/DEV_ONBOARDING_CHECKLIST.md), there's no
 * reason this should have stayed untested. The core thing worth proving:
 * the MISSING vs EMPTY vs SET three-way distinction this tool exists for
 * in the first place (a bare `cat .env` can't tell them apart; this script
 * must), and that a secret's real value is never printed.
 *
 * Run with: node test/check-env.test.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { parseArgs, parseDotEnv, requiredEnvVarsFromTestCase, displayValue, checkVar, SECRET_NAME_RE } = require("../check-env");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    failed += 1;
  }
}

function tmpFile(content) {
  const file = path.join(os.tmpdir(), `check-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(file, content);
  return file;
}

// --- parseArgs ---------------------------------------------------------

test("parseArgs defaults envFile to .env and testCaseFile to null", () => {
  const args = parseArgs([]);
  assert.strictEqual(args.envFile, ".env");
  assert.strictEqual(args.testCaseFile, null);
});

test("parseArgs reads --env-file and a positional test-case path", () => {
  const args = parseArgs(["--env-file", "/tmp/custom.env", "test-cases/addons.ios.json"]);
  assert.strictEqual(args.envFile, "/tmp/custom.env");
  assert.strictEqual(args.testCaseFile, "test-cases/addons.ios.json");
});

// --- parseDotEnv: the MISSING vs EMPTY vs SET distinction this tool exists for ---

test("parseDotEnv: a normal KEY=value line is SET", () => {
  const file = tmpFile("TESTOPS_MOBILE_APPIUM_PROVIDER=browserstack\n");
  try {
    const { map, found } = parseDotEnv(file);
    assert.strictEqual(found, true);
    assert.strictEqual(map.get("TESTOPS_MOBILE_APPIUM_PROVIDER"), "browserstack");
  } finally {
    fs.unlinkSync(file);
  }
});

test("parseDotEnv: a KEY= line with nothing after '=' parses as an explicit empty string, not absent", () => {
  const file = tmpFile("TESTOPS_MOBILE_BATCH_LOGIN_PASSWORD=\n");
  try {
    const { map } = parseDotEnv(file);
    assert.ok(map.has("TESTOPS_MOBILE_BATCH_LOGIN_PASSWORD"), "the key must be present in the map at all -- this is the real bug class: EMPTY looks identical to MISSING in a plain `cat .env`");
    assert.strictEqual(map.get("TESTOPS_MOBILE_BATCH_LOGIN_PASSWORD"), "");
  } finally {
    fs.unlinkSync(file);
  }
});

test("parseDotEnv: a key never mentioned in the file at all is absent from the map (true MISSING)", () => {
  const file = tmpFile("TESTOPS_MOBILE_APPIUM_PROVIDER=browserstack\n");
  try {
    const { map } = parseDotEnv(file);
    assert.strictEqual(map.has("TESTOPS_MOBILE_NEVER_MENTIONED"), false);
  } finally {
    fs.unlinkSync(file);
  }
});

test("parseDotEnv: comments and blank lines are ignored", () => {
  const file = tmpFile("# a comment\n\nTESTOPS_MOBILE_APPIUM_PROVIDER=browserstack\n   \n# TESTOPS_MOBILE_COMMENTED_OUT=value\n");
  try {
    const { map } = parseDotEnv(file);
    assert.strictEqual(map.get("TESTOPS_MOBILE_APPIUM_PROVIDER"), "browserstack");
    assert.strictEqual(map.has("TESTOPS_MOBILE_COMMENTED_OUT"), false);
  } finally {
    fs.unlinkSync(file);
  }
});

test("parseDotEnv: a missing file returns found:false and an empty map, not a throw", () => {
  const { map, found } = parseDotEnv("/no/such/file/anywhere.env");
  assert.strictEqual(found, false);
  assert.strictEqual(map.size, 0);
});

test("parseDotEnv: a value containing '=' keeps everything after the first '=' (e.g. a base64 or URL value)", () => {
  const file = tmpFile("TESTOPS_MOBILE_BROWSERSTACK_APP_URL=bs://abc123==\n");
  try {
    const { map } = parseDotEnv(file);
    assert.strictEqual(map.get("TESTOPS_MOBILE_BROWSERSTACK_APP_URL"), "bs://abc123==");
  } finally {
    fs.unlinkSync(file);
  }
});

// --- requiredEnvVarsFromTestCase -----------------------------------------

test("requiredEnvVarsFromTestCase scans every step's text for a ${VAR} placeholder, de-duplicated", () => {
  const file = tmpFile(
    JSON.stringify({
      name: "fixture",
      steps: [
        { kind: "type", instruction: "type the phone number", text: "${TESTOPS_MOBILE_BATCH_LOGIN_PHONE}" },
        { kind: "type", instruction: "type the password", text: "${TESTOPS_MOBILE_BATCH_LOGIN_PASSWORD}" },
        { kind: "type", instruction: "retype the phone number elsewhere", text: "${TESTOPS_MOBILE_BATCH_LOGIN_PHONE}" },
        { kind: "tap", instruction: "tap LOGIN" },
      ],
    })
  );
  try {
    const required = requiredEnvVarsFromTestCase(file);
    assert.deepStrictEqual(required.sort(), ["TESTOPS_MOBILE_BATCH_LOGIN_PASSWORD", "TESTOPS_MOBILE_BATCH_LOGIN_PHONE"]);
  } finally {
    fs.unlinkSync(file);
  }
});

test("requiredEnvVarsFromTestCase finds a ${VAR} placeholder in step text", () => {
  const file = tmpFile(
    JSON.stringify({
      name: "fixture",
      steps: [{ kind: "type", instruction: "type the phone number", text: "${TESTOPS_MOBILE_BATCH_LOGIN_PHONE}" }],
    })
  );
  try {
    const required = requiredEnvVarsFromTestCase(file);
    assert.ok(required.includes("TESTOPS_MOBILE_BATCH_LOGIN_PHONE"));
  } finally {
    fs.unlinkSync(file);
  }
});

test("requiredEnvVarsFromTestCase throws a clean error (not a raw JSON.parse crash) for an invalid file", () => {
  const file = tmpFile("{ not valid json");
  try {
    assert.throws(() => requiredEnvVarsFromTestCase(file));
  } finally {
    fs.unlinkSync(file);
  }
});

// --- displayValue: never print a real secret ------------------------------

test("displayValue hides anything matching PASSWORD|KEY|SECRET|TOKEN, case-insensitively", () => {
  assert.strictEqual(displayValue("TESTOPS_MOBILE_BATCH_LOGIN_PASSWORD", "hunter2"), "SET (hidden)");
  assert.strictEqual(displayValue("TESTOPS_MOBILE_BROWSERSTACK_KEY", "abc123"), "SET (hidden)");
  assert.strictEqual(displayValue("some_secret_value", "x"), "SET (hidden)");
  assert.strictEqual(displayValue("API_TOKEN", "x"), "SET (hidden)");
});

test("displayValue shows the real value for a non-secret var", () => {
  assert.strictEqual(displayValue("TESTOPS_MOBILE_APPIUM_PROVIDER", "browserstack"), 'SET ("browserstack")');
});

test("SECRET_NAME_RE matches the documented credential-name patterns", () => {
  for (const name of ["PASSWORD", "MY_PASSWORD", "API_KEY", "SECRET", "ACCESS_TOKEN"]) {
    assert.ok(SECRET_NAME_RE.test(name), `expected ${name} to match`);
  }
  assert.strictEqual(SECRET_NAME_RE.test("TESTOPS_MOBILE_APPIUM_PROVIDER"), false);
});

// --- checkVar: the three-way status this whole tool exists to report ------

test("checkVar reports MISSING when the var is in neither the env map nor process.env", () => {
  const env = new Map();
  const result = checkVar("TESTOPS_MOBILE_NEVER_SET", env, {});
  assert.strictEqual(result.status, "MISSING");
});

test("checkVar reports EMPTY when the var is present but an empty string", () => {
  const env = new Map([["TESTOPS_MOBILE_BATCH_LOGIN_PASSWORD", ""]]);
  const result = checkVar("TESTOPS_MOBILE_BATCH_LOGIN_PASSWORD", env, {});
  assert.strictEqual(result.status, "EMPTY");
});

test("checkVar reports SET when the var has a real value", () => {
  const env = new Map([["TESTOPS_MOBILE_APPIUM_PROVIDER", "browserstack"]]);
  const result = checkVar("TESTOPS_MOBILE_APPIUM_PROVIDER", env, {});
  assert.strictEqual(result.status, "SET");
});

test("checkVar never includes the real value of a secret var in its result, even internally", () => {
  const env = new Map([["TESTOPS_MOBILE_BATCH_LOGIN_PASSWORD", "hunter2"]]);
  const result = checkVar("TESTOPS_MOBILE_BATCH_LOGIN_PASSWORD", env, {});
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("hunter2"), `result must never carry the raw secret value: ${serialized}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
