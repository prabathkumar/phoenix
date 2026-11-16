/**
 * One way for the engine, the release agents and the MCP server to send logs: a queue that posts batches to the Phoenix API (/api/ingest),
 * which masks and stores them in ClickHouse. Fire-and-forget: a log never slows a model call or fails a run.
 *   PHOENIX_API_URL (e.g. http://phoenix-api:8000) - unset means logs are only kept in memory (sink = none)
 *   PHOENIX_INGEST_TOKEN - sent as x-ingest-token when set
 * Batch = 100 events or 1 second. If the API is down the batch is kept (up to 5000) and retried on the next flush.
 */
function createLogger(env = process.env, { fetchImpl = globalThis.fetch, every = 1000, batch = 100, max = 5000 } = {}) {
  const base = String(env.PHOENIX_API_URL || "").replace(/\/$/, "");
  const queue = []; let timer = null; let sending = false; const stats = { sent: 0, dropped: 0, failed: 0 };
  async function flush() {
    if (!base || sending || !queue.length) return 0;
    sending = true; const events = queue.splice(0, 500);
    try {
      const r = await fetchImpl(`${base}/api/ingest`, { method: "POST", headers: { "content-type": "application/json", ...(env.PHOENIX_INGEST_TOKEN ? { "x-ingest-token": env.PHOENIX_INGEST_TOKEN } : {}) }, body: JSON.stringify({ events }), signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`ingest ${r.status}`);
      stats.sent += events.length; return events.length;
    } catch { stats.failed += 1; queue.unshift(...events); const over = queue.length - max; if (over > 0) { queue.splice(0, over); stats.dropped += over; } return 0; }
    finally { sending = false; }
  }
  function log(kind, row) {
    if (!base) return;
    queue.push({ kind, row: { project: env.PHOENIX_PROJECT_ID || "", ...row } });
    if (queue.length >= batch) { flush(); return; }
    if (!timer) { timer = setTimeout(() => { timer = null; flush(); }, every); if (timer.unref) timer.unref(); }
  }
  /** wrap a model-asking function: logs an agent_event (timing, status) and, when capture is on, the prompt/answer as a training example */
  function wrapAsk(ask, { agent = "agent", project = "", capture = String(env.PHOENIX_TRAIN_CAPTURE || "") === "1" } = {}) {
    if (!ask) return ask;
    return async (prompt, ...rest) => {
      const t0 = Date.now();
      try {
        const out = await ask(prompt, ...rest);
        log("agent_event", { project, agent, event: "model-call", status: "ok", ms: Date.now() - t0 });
        if (capture) log("training_example", { project, source: agent, prompt: String(prompt), response: String(out || ""), outcome: "unknown" });
        return out;
      } catch (e) { log("agent_event", { project, agent, event: "model-call", status: "failed", ms: Date.now() - t0, detail: e.message }); throw e; }
    };
  }
  return { log, flush, wrapAsk, stats, size: () => queue.length };
}
let shared = null;
/** one logger per process for code that has no logger passed in (the goal loop). */
function sharedLogger(env = process.env) { if (!shared) shared = createLogger(env); return shared; }
module.exports = { createLogger, sharedLogger };
