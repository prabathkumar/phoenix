/**
 * Shared pass/fail result contract -- ONE shape for every platform
 * (android, ios, web) so TestOps, the manager summary, and the FrothAI
 * push all read the same thing regardless of which runner produced it.
 *
 * Outcome rule (the whole definition of pass/fail, in one place):
 *   - a test case is "pass" only if EVERY non-optional step is "pass"
 *     (or "skipped" for a tapIfExists/optional step that legitimately
 *     had nothing to act on);
 *   - any step with status "fail" makes the test case "fail";
 *   - a test case that ran zero steps is "fail" (nothing was proven).
 *
 * Step status values: "pass" | "fail" | "skipped".
 */

const VALID_STEP_STATUS = new Set(["pass", "fail", "skipped"]);

/**
 * @param {Object} input
 * @param {"android"|"ios"|"web"} input.platform
 * @param {string} [input.testCase] - test case name or file
 * @param {Array<{index:number, kind:string, instruction:string, status:"pass"|"fail"|"skipped", reason?:string, selector?:Object, durationMs?:number}>} input.steps
 * @param {number} [input.startedAt] - epoch ms
 * @param {number} [input.finishedAt] - epoch ms
 * @param {string} [input.error] - a run-level error (session lost etc.) -> fail
 */
function buildTestResult({ platform, testCase, steps, startedAt, finishedAt, error }) {
  const list = Array.isArray(steps) ? steps : [];
  for (const s of list) {
    if (!VALID_STEP_STATUS.has(s.status)) {
      throw new Error(`invalid step status "${s.status}" (step ${s.index})`);
    }
  }
  const failed = list.filter((s) => s.status === "fail");
  const passed = list.filter((s) => s.status === "pass");
  const skipped = list.filter((s) => s.status === "skipped");

  let status = "pass";
  let detail;
  if (error) {
    status = "fail";
    detail = `run error: ${error}`;
  } else if (failed.length > 0) {
    status = "fail";
    const first = failed[0];
    detail = `step ${first.index} "${first.instruction}" failed: ${first.reason || "unknown reason"}`;
  } else if (passed.length === 0) {
    status = "fail";
    detail = "no steps were executed -- nothing was proven";
  } else {
    detail = `${passed.length} step(s) passed${skipped.length ? `, ${skipped.length} skipped` : ""}`;
  }

  return {
    status,
    success: status === "pass",
    detail,
    platform,
    testCase,
    summary: { total: list.length, passed: passed.length, failed: failed.length, skipped: skipped.length },
    steps: list,
    startedAt,
    finishedAt,
    durationMs: typeof startedAt === "number" && typeof finishedAt === "number" ? finishedAt - startedAt : undefined,
  };
}

module.exports = { buildTestResult, VALID_STEP_STATUS };
