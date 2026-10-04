/**
 * POST /api/apply-recorded-step and POST /api/record-step/:id/stop --
 * the second half of the "Record this step" manual fallback (see
 * record-step-endpoint.js's header for the full picture).
 *
 * Once a tester has tapped the real element via the live-view WebSocket
 * a /api/record-step call started, this endpoint takes the resulting
 * capture/recorder.js CapturedStep and writes it into the failing test
 * case's step as a resolvedSelector -- closing the loop the lifecycle
 * diagram in docs/TESTOPS_WORKFLOW_UX.md calls out in red ("WIRING NOT
 * BUILT"). No new resolution logic: CapturedStep.resolvedElement is
 * already exactly the {strategy, value} shape test-case-runner.js's
 * resolvedSelector field expects and generation/pipeline.js's
 * buildSelector() already knows how to turn into a real WebdriverIO
 * selector -- this endpoint only extracts {strategy, value} from it and
 * writes it to disk, same convention every hand-authored resolvedSelector
 * in test-cases/*.json already follows (see e.g. test-cases/addons.json).
 *
 * Gated behind TESTOPS_MOBILE_ENABLE_RECORD_STEP_API=1, same as
 * record-step-endpoint.js.
 *
 * POST /api/apply-recorded-step request body (JSON):
 *   {
 *     "recordingId": "...",      // required -- from /api/record-step's response
 *     "testCaseFile": "addons.json",  // required -- a real file under test-cases/
 *     "stepIndex": 20,                // required -- which step in that file to pin
 *     "recorderStepIndex": 0          // optional -- WHICH of the tester's taps
 *                                     // (a tester may tap more than once while
 *                                     // finding the right element); defaults to
 *                                     // the most recent tap
 *   }
 *
 * Response: { success: true, resolvedSelector: {strategy, value}, testCaseFile, stepIndex }
 * or { success: false, error: "..." }
 *
 * POST /api/record-step/:id/stop -- stops ONLY the live-view WebSocket
 * server for that recording (never the underlying device session --
 * that's TestOps's to close, same rule as everywhere else in this
 * integration). Response: { success: true } or { success: false, error }.
 */

const fs = require("fs");
const path = require("path");
const { recordings } = require("./recording-registry");

const TEST_CASES_DIR = path.join(__dirname, "..", "test-cases");

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

function respondJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
async function handleApplyRecordedStep(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    respondJson(res, 400, { success: false, error: err.message });
    return;
  }

  const { recordingId, testCaseFile, stepIndex, recorderStepIndex } = body;

  if (!recordingId) {
    respondJson(res, 400, { success: false, error: "recordingId is required (from a prior /api/record-step call)" });
    return;
  }
  if (!testCaseFile) {
    respondJson(res, 400, { success: false, error: "testCaseFile is required" });
    return;
  }
  if (!Number.isInteger(stepIndex) || stepIndex < 0) {
    respondJson(res, 400, { success: false, error: "stepIndex must be a non-negative integer" });
    return;
  }

  const entry = recordings.get(recordingId);
  if (!entry) {
    respondJson(res, 200, { success: false, error: `no active recording for recordingId "${recordingId}" (it may have been applied/stopped already, or expired)` });
    return;
  }

  const { recorder } = entry;
  if (recorder.steps.length === 0) {
    respondJson(res, 200, { success: false, error: "no tap has been recorded yet on this recording -- have the tester tap the element first" });
    return;
  }

  const idx = Number.isInteger(recorderStepIndex) ? recorderStepIndex : recorder.steps.length - 1;
  const capturedStep = recorder.steps[idx];
  if (!capturedStep) {
    respondJson(res, 200, { success: false, error: `no recorded tap at recorderStepIndex ${idx} (${recorder.steps.length} tap(s) recorded so far)` });
    return;
  }
  if (!capturedStep.resolvedElement || !capturedStep.resolvedElement.strategy || !capturedStep.resolvedElement.value) {
    respondJson(res, 200, { success: false, error: "the recorded tap did not resolve to a usable element (coordinate-only fallback, no accessibility info at the tap point)" });
    return;
  }

  // Same minimal {strategy, value} shape every hand-authored
  // resolvedSelector in test-cases/*.json already uses -- deliberately
  // NOT the full CapturedStep.resolvedElement object (which also
  // carries resourceId/contentDesc/text/bounds/xpath/className
  // separately) to keep the committed JSON git-diffable and consistent
  // with every selector already in these files.
  const resolvedSelector = {
    strategy: capturedStep.resolvedElement.strategy,
    value: capturedStep.resolvedElement.value,
  };

  const safeName = path.basename(testCaseFile);
  const filePath = path.join(TEST_CASES_DIR, safeName);
  if (!filePath.startsWith(TEST_CASES_DIR) || !fs.existsSync(filePath)) {
    respondJson(res, 200, { success: false, error: `no such test case: ${safeName}` });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    respondJson(res, 200, { success: false, error: `could not parse ${safeName}: ${err.message}` });
    return;
  }

  const isBareArray = Array.isArray(parsed);
  const steps = isBareArray ? parsed : parsed.steps;
  if (!Array.isArray(steps)) {
    respondJson(res, 200, { success: false, error: `${safeName} has no steps array` });
    return;
  }
  if (stepIndex >= steps.length) {
    respondJson(res, 200, { success: false, error: `stepIndex ${stepIndex} is out of range (${safeName} has ${steps.length} step(s))` });
    return;
  }

  const existingNote = steps[stepIndex].note;
  const stamp = new Date().toISOString();
  const recordedNote = `Captured via the "Record this step" manual fallback on ${stamp} (recordingId ${recordingId}): a tester tapped the real element live on the failing screen; resolved via capture/recorder.js's resolveElementAtCoordinate() against the real accessibility tree at that moment.`;
  steps[stepIndex] = {
    ...steps[stepIndex],
    resolvedSelector,
    note: existingNote ? `${existingNote}\n\n${recordedNote}` : recordedNote,
  };

  try {
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2) + "\n");
  } catch (err) {
    respondJson(res, 200, { success: false, error: `could not write ${safeName}: ${err.message}` });
    return;
  }

  respondJson(res, 200, { success: true, resolvedSelector, testCaseFile: safeName, stepIndex });
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} recordingId
 */
function handleStopRecording(req, res, recordingId) {
  const entry = recordings.get(recordingId);
  if (!entry) {
    respondJson(res, 200, { success: false, error: `no active recording for recordingId "${recordingId}"` });
    return;
  }
  try {
    entry.wss.close();
  } catch (err) {
    // best-effort -- still remove it from the registry below regardless
  }
  recordings.delete(recordingId);
  respondJson(res, 200, { success: true });
}

module.exports = { handleApplyRecordedStep, handleStopRecording };
