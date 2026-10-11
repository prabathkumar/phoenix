/**
 * Adapter: our shared result contract (engine/test-result.js) -> a
 * FrothTestOps execution. PROVISIONAL on the wire: the TestOps WRITE API
 * isn't known yet (the read-only RD_Test_Ops connector reports
 * write_actions_enabled=false), so the endpoint path and payload below are
 * our own documented shape behind an injectable `post`. When the real
 * contract arrives, only buildExecutionPayload() / the URL need to change;
 * the status mapping, the ref validation and the fail-soft behaviour stay.
 *
 * Observed TestOps data model (read-only connector, project 132):
 *   project -> requirement -> scenario -> test case (ref "APP-TC-1")
 *           -> test cycle (ref "APP-TCY-1") -> execution (status "PASSED")
 *   summary counts: passed / failed / not_run / skipped.
 * Only "PASSED" has been seen in real data; "FAILED"/"SKIPPED"/"NOT_RUN"
 * follow the summary's own count names and must be confirmed before go-live.
 *
 * A test-case JSON links to TestOps with an optional top-level
 * `"testopsRef": "APP-TC-1"`.
 *
 * Config: TESTOPS_MOBILE_TESTOPS_URL, TESTOPS_MOBILE_TESTOPS_TOKEN.
 * Push never changes the test outcome: failures are reported, not thrown.
 */

const TESTCASE_REF = /^[A-Z][A-Z0-9]*-TC-\d+$/;
const CYCLE_REF = /^[A-Z][A-Z0-9]*-TCY-\d+$/;

const STATUS_MAP = { pass: "PASSED", fail: "FAILED", skipped: "SKIPPED" };

/** Our step/case status -> TestOps execution status. Unknown/absent -> NOT_RUN. */
function toTestOpsStatus(status) {
  return STATUS_MAP[status] || "NOT_RUN";
}

function validateRefs({ testopsRef, cycleRef }) {
  if (!testopsRef || !TESTCASE_REF.test(String(testopsRef))) {
    return `testopsRef must look like "APP-TC-1" (got ${JSON.stringify(testopsRef)})`;
  }
  if (cycleRef !== undefined && !CYCLE_REF.test(String(cycleRef))) {
    return `cycleRef must look like "APP-TCY-1" (got ${JSON.stringify(cycleRef)})`;
  }
  return null;
}

/** @param {Object} result engine/test-result.js shape */
function buildExecutionPayload(result, { testopsRef, cycleRef }) {
  return {
    testCaseRef: testopsRef,
    cycleRef,
    status: toTestOpsStatus(result.status),
    platform: result.platform,
    detail: result.detail,
    summary: result.summary,
    durationMs: result.durationMs,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    steps: (result.steps || []).map((s) => ({
      index: s.index,
      kind: s.kind,
      instruction: s.instruction,
      status: toTestOpsStatus(s.status),
      reason: s.reason,
      durationMs: s.durationMs,
    })),
  };
}

function defaultPost(url, token, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then(async (res) => ({ ok: res.ok, status: res.status, text: await res.text() }));
}

/**
 * @returns {Promise<{pushed: boolean, reason?: string, error?: string, payload?: Object}>}
 */
async function pushResult(result, { testopsRef, cycleRef, env = process.env, post = defaultPost } = {}) {
  const refError = validateRefs({ testopsRef, cycleRef });
  if (refError) return { pushed: false, reason: refError };
  const url = env.TESTOPS_MOBILE_TESTOPS_URL;
  if (!url) return { pushed: false, reason: "TESTOPS_MOBILE_TESTOPS_URL is not set -- push skipped (the test outcome is unaffected)" };
  const payload = buildExecutionPayload(result, { testopsRef, cycleRef });
  try {
    const res = await post(url, env.TESTOPS_MOBILE_TESTOPS_TOKEN, payload);
    if (!res.ok) return { pushed: false, error: `TestOps responded ${res.status}: ${String(res.text).slice(0, 300)}`, payload };
    return { pushed: true, payload };
  } catch (err) {
    return { pushed: false, error: err.message, payload };
  }
}

module.exports = { toTestOpsStatus, validateRefs, buildExecutionPayload, pushResult, TESTCASE_REF, CYCLE_REF };
