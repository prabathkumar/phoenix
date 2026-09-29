/**
 * POST /api/semantic-action — EXPERIMENTAL, off by default. First real
 * product-surface entry point for Phase 2's semantic action layer
 * (docs/PHOENIX_SPEC.md §6 / README's Act 2 section), as opposed to
 * run-semantic-action.js's CLI, which exists only to prove the executor
 * against real hardware by hand. This is what "wiring it into a real
 * product surface" (the item both docs called out as still open) looks
 * like as a first cut: a JSON endpoint that runs one instruction
 * against whatever recording session is already active, via the same
 * engine/semantic-act-executor.js the CLI uses.
 *
 * Deliberately gated behind PHOENIX_ENABLE_SEMANTIC_API=1 (checked by
 * frontend/server.js before this module's handler is even reachable —
 * see server.js) and off by default, for two reasons:
 *   1. It has never been run against a real device (see README/spec) —
 *      nothing should depend on it working correctly yet.
 *   2. Prabath is explicitly holding dev-team adoption until the
 *      implementation is complete; an always-on endpoint would be a
 *      product surface the moment it merges, before that's true.
 *
 * Acts on the SAME session a tester is already recording through
 * (engine/session-manager.js's getActiveSession()) — it does not start
 * its own session. There is deliberately no way to start a session from
 * this endpoint; that stays the upload flow's job.
 */

const { getActiveSession } = require("../engine/session-manager");
const { executeSemanticAction } = require("../engine/semantic-act-executor");

const MAX_BODY_BYTES = 64 * 1024; // a JSON instruction is tiny; generous but not unbounded

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
function handleSemanticAction(req, res) {
  readJsonBody(req, (err, body) => {
    if (err) {
      respondJson(res, 400, { error: err.message });
      return;
    }

    const { instruction, kind, text, useVisualGrounding } = body || {};
    if (typeof instruction !== "string" || !instruction.trim()) {
      respondJson(res, 400, { error: 'Request body must include a non-empty "instruction" string.' });
      return;
    }
    if (kind !== undefined && kind !== "tap" && kind !== "type") {
      respondJson(res, 400, { error: 'If given, "kind" must be "tap" or "type".' });
      return;
    }

    const session = getActiveSession();
    if (!session) {
      respondJson(res, 409, {
        error: "No recording session is active. Start one (upload an app) before running a semantic action against it.",
      });
      return;
    }

    executeSemanticAction(session.driver, instruction, { kind, text, platform: session.platform, useVisualGrounding: Boolean(useVisualGrounding) })
      .then((result) => {
        respondJson(res, result.success ? 200 : 422, result);
      })
      .catch((err2) => {
        // executeSemanticAction is documented never to throw -- this is
        // a last-resort net in case a future change breaks that
        // contract, so the endpoint still fails safely rather than
        // hanging or 500ing without explanation.
        console.error("[semantic-action-endpoint] unexpected error:", err2);
        respondJson(res, 500, { error: `Unexpected error: ${err2.message}` });
      });
  });
}

function readJsonBody(req, callback) {
  let received = 0;
  const chunks = [];
  let done = false;

  req.on("data", (chunk) => {
    if (done) return;
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      done = true;
      callback(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    if (done) return;
    done = true;
    try {
      const parsed = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
      callback(null, parsed);
    } catch (err) {
      callback(new Error(`Invalid JSON body: ${err.message}`));
    }
  });

  req.on("error", (err) => {
    if (done) return;
    done = true;
    callback(err);
  });
}

function respondJson(res, statusCode, body) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

module.exports = { handleSemanticAction };
