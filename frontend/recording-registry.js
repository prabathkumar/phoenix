/**
 * In-memory registry of in-flight "Record this step" live-view sessions,
 * shared between record-step-endpoint.js (creates an entry) and
 * apply-recorded-step-endpoint.js (reads from it). A separate module
 * purely so both endpoint files can require the SAME Map instance --
 * requiring each other directly would work too, but this avoids any
 * order-of-require ambiguity.
 *
 * Deliberately process-local, in-memory, not persisted: a recording is a
 * short-lived, single-tester, single-session affair (tap, see the
 * resolved selector, apply it, done) -- there is no case here for
 * surviving a server restart, and persisting it would just be a second
 * place state about a live BrowserStack session could go stale.
 */

/** @type {Map<string, {wss: Object, recorder: Object, driver: Object, platform: string, sessionId: string, createdAt: number}>} */
const recordings = new Map();

/** Drops any recording older than this when a new one is created, so a
 * tester who never called the "stop" endpoint (closed the tab, gave up)
 * doesn't leak a WebSocketServer forever. Generous on purpose -- this is
 * a backstop, not a tight TTL; a real "Record this step" interaction is
 * expected to take seconds to a couple of minutes, not hours. */
const STALE_MS = 30 * 60 * 1000;

function pruneStale() {
  const now = Date.now();
  for (const [id, entry] of recordings) {
    if (now - entry.createdAt > STALE_MS) {
      try {
        entry.wss.close();
      } catch {
        // best-effort -- the socket may already be gone
      }
      recordings.delete(id);
    }
  }
}

module.exports = { recordings, pruneStale };
