/**
 * Opt-in INTEGRATION test for vision fusion's actual model accuracy --
 * not its wiring (that's already covered by semantic-act.test.js's
 * "passes the screenshot through to callOllamaJson's images option"
 * tests, which run every CI build with a fake model).
 *
 * What THIS file is for: does a real multimodal-capable Ollama model
 * actually resolve an icon-only, text-ambiguous instruction correctly
 * when given a real screenshot, on a real captured screen? That's a
 * model-accuracy question, not a code-correctness question -- it can't
 * be answered by a fake model returning a canned {ref: N}, and it
 * shouldn't run on every CI build (needs a real local Ollama + a
 * multimodal model pulled, e.g. `ollama pull llava`).
 *
 * This is SKIPPED by default. It only runs when:
 *   1. PHOENIX_VISION_INTEGRATION_TEST=1 is set, AND
 *   2. a real Ollama server is reachable, AND
 *   3. a fixture pair exists for the case being tested (see FIXTURES below).
 *
 * See docs/DEV_ONBOARDING_CHECKLIST.md's Layer 3 section for the real bug
 * this guards against (docs/STATUS.md bug #17: the Android LOGOUT control
 * is an icon with content-desc "Right Icon", zero textual relation to
 * "logout" anywhere in the accessibility tree -- today's fix is a pinned
 * selector precisely because nothing has ever confirmed vision fusion
 * would resolve it correctly from the instruction alone).
 *
 * TO ADD A REAL FIXTURE (this is the onboarding task, not already done):
 *   1. Run a real session, capture the screen in question.
 *   2. Save its page-source XML to generation/test/fixtures/<name>.xml.
 *   3. Save a matching screenshot (base64-encoded PNG, no data: prefix)
 *      to generation/test/fixtures/<name>.b64.
 *   4. Add an entry to FIXTURES below with the instruction and the
 *      expected result (a ref index, or null for "should decline").
 *
 * Run with: PHOENIX_VISION_INTEGRATION_TEST=1 node test/semantic-act-vision-integration.test.js
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const FIXTURES_DIR = path.join(__dirname, "fixtures");

// Add real cases here once a fixture pair exists. Each entry names an
// <name>.xml (page source) + <name>.b64 (screenshot) pair under
// generation/test/fixtures/, an instruction to resolve, and the expected
// outcome. Empty today -- see docs/DEV_ONBOARDING_CHECKLIST.md's Layer 3
// section; the Android "Right Icon" logout case is the first candidate.
const FIXTURES = [
  // {
  //   name: "android-right-icon-logout",
  //   instruction: "tap the LOGOUT icon in the Profile screen's top header",
  //   expectRef: "whatever ref number the real snapshot assigns the Right Icon element",
  // },
];

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name, fn) {
  return fn(name);
}

async function ollamaReachable() {
  const host = process.env.PHOENIX_OLLAMA_HOST || "http://localhost:11434";
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log("generation/semantic-act vision-fusion integration test:");

  if (process.env.PHOENIX_VISION_INTEGRATION_TEST !== "1") {
    console.log("  SKIPPED -- set PHOENIX_VISION_INTEGRATION_TEST=1 to run (needs a real multimodal Ollama model).");
    console.log("  This is expected to be skipped in normal CI runs; it is not part of the required-tests gate.");
    process.exit(0);
  }

  if (!(await ollamaReachable())) {
    console.log("  SKIPPED -- no Ollama server reachable at " + (process.env.PHOENIX_OLLAMA_HOST || "http://localhost:11434"));
    process.exit(0);
  }

  if (FIXTURES.length === 0) {
    console.log("  SKIPPED -- no fixtures registered yet. See this file's header for how to add one.");
    console.log("  (This is the real, current state: vision fusion's wiring is tested, its real-model accuracy is not.)");
    process.exit(0);
  }

  const { resolveSemanticAction } = require("../semantic-act");

  for (const fixture of FIXTURES) {
    const xmlPath = path.join(FIXTURES_DIR, `${fixture.name}.xml`);
    const b64Path = path.join(FIXTURES_DIR, `${fixture.name}.b64`);
    if (!fs.existsSync(xmlPath) || !fs.existsSync(b64Path)) {
      console.log(`  SKIPPED - ${fixture.name} (fixture files not found)`);
      skipped += 1;
      continue;
    }
    const xml = fs.readFileSync(xmlPath, "utf8");
    const screenshotBase64 = fs.readFileSync(b64Path, "utf8").trim();

    try {
      const result = await resolveSemanticAction(xml, fixture.instruction, { screenshotBase64, kind: "tap" });
      const actualRef = result.resolved ? result.ref : null;
      assert.strictEqual(actualRef, fixture.expectRef, `expected ref ${fixture.expectRef}, got ${actualRef} (reason: ${result.reason || "n/a"})`);
      console.log(`  ok - ${fixture.name}`);
      passed += 1;
    } catch (err) {
      console.error(`  FAIL - ${fixture.name}`);
      console.error(err);
      failed += 1;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
