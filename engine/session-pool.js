/**
 * Device/session pool abstraction — tracks how many recording sessions
 * are allowed to run at once, assigns each one a slot (and a free
 * live-view port), and rejects a request once the pool is full.
 *
 * Why this exists: `session-manager.js` originally tracked "is a
 * session running" with a single module-level `let active = null;`
 * variable (see git history / docs/STATUS.md's old "Concurrent
 * sessions" backlog entry) — a second `startRecordingSession()` call
 * while one was active threw, and `frontend/upload-session.js` turned
 * that into a 409 for the tester. That matched the two real constraints
 * at the time: `live-view/server.js` bound one fixed port
 * (`TESTOPS_MOBILE_LIVE_VIEW_PORT`, default 8090) and nothing allocated a
 * different one per session, and `capture/recorder.js`/session-manager
 * itself only ever tracked one driver/recorder/wss triple.
 *
 * This module generalizes that single slot into N slots (capacity
 * configurable via `TESTOPS_MOBILE_SESSION_POOL_SIZE`, default **1** — so an
 * un-configured deployment behaves identically to before this existed):
 * each slot gets its own live-view port (allocated sequentially from
 * `TESTOPS_MOBILE_LIVE_VIEW_PORT`, default 8090, skipping ports already
 * claimed by another live slot in this same process) so two concurrent
 * sessions never collide on the same WebSocket port. Rejecting when
 * full follows the same style `remote-provider.js`'s capability
 * validation and `upload-session.js`'s upload-size limit already use
 * elsewhere in this codebase: throw a plain `Error` with a message
 * meant to reach the caller (test-ops tester, API client) directly,
 * rather than returning a sentinel the caller might forget to check.
 *
 * This module itself never starts or tears down a real Appium
 * session/WebSocket server — it only tracks slots and ports.
 * `session-manager.js` is the only caller that does the real work;
 * this is deliberately dependency-free (no `webdriverio`, no `ws`) so
 * it's trivial to unit-test in isolation.
 */

const DEFAULT_CAPACITY = 1;
const DEFAULT_BASE_PORT = 8090;

class SessionPoolFullError extends Error {
  constructor(capacity) {
    super(
      `Session pool is full (capacity: ${capacity}). Stop an active session before starting another, ` +
        `or raise TESTOPS_MOBILE_SESSION_POOL_SIZE if more devices/slots are actually available.`
    );
    this.name = "SessionPoolFullError";
    this.capacity = capacity;
  }
}

class SessionPool {
  /**
   * @param {object} [options]
   * @param {number} [options.capacity] - max concurrent sessions. Falls
   *   back to TESTOPS_MOBILE_SESSION_POOL_SIZE, then 1 (today's behavior).
   * @param {number} [options.basePort] - first live-view port to hand
   *   out. Falls back to TESTOPS_MOBILE_LIVE_VIEW_PORT, then 8090.
   */
  constructor(options = {}) {
    const configuredCapacity = options.capacity !== undefined
      ? options.capacity
      : Number(process.env.TESTOPS_MOBILE_SESSION_POOL_SIZE);
    this.capacity = Number.isFinite(configuredCapacity) && configuredCapacity > 0
      ? Math.floor(configuredCapacity)
      : DEFAULT_CAPACITY;

    const configuredBasePort = options.basePort !== undefined
      ? options.basePort
      : Number(process.env.TESTOPS_MOBILE_LIVE_VIEW_PORT);
    this.basePort = Number.isFinite(configuredBasePort) && configuredBasePort > 0
      ? Math.floor(configuredBasePort)
      : DEFAULT_BASE_PORT;

    /** @type {Map<string, {port: number, platform: string, driver: unknown, wss: unknown}>} */
    this.slots = new Map();
  }

  size() {
    return this.slots.size;
  }

  hasCapacity() {
    return this.slots.size < this.capacity;
  }

  /**
   * Picks the lowest live-view port, starting at basePort, not already
   * held by another slot in this pool. Two concurrent sessions in the
   * same process therefore never get the same port even if they're
   * started a tick apart.
   */
  allocatePort() {
    const used = new Set(Array.from(this.slots.values(), (slot) => slot.port));
    let candidate = this.basePort;
    while (used.has(candidate)) candidate += 1;
    return candidate;
  }

  /**
   * Reserves a slot for a new session. Throws SessionPoolFullError if
   * the pool is already at capacity -- callers (session-manager.js)
   * are expected to let that propagate (or translate it, as
   * upload-session.js's 409 handler does for the tester-facing flow).
   *
   * @param {string} sessionKey - a caller-chosen unique key for this
   *   session (session-manager.js uses the driver's own sessionId once
   *   it's known, but the slot is reserved before that exists, so a
   *   temporary key is fine too).
   * @param {{port: number, platform: string, driver?: unknown, wss?: unknown}} data
   */
  acquire(sessionKey, data) {
    if (!this.hasCapacity()) throw new SessionPoolFullError(this.capacity);
    if (this.slots.has(sessionKey)) {
      throw new Error(`Session pool already has a slot keyed "${sessionKey}".`);
    }
    this.slots.set(sessionKey, { ...data });
  }

  /**
   * Updates fields on an already-acquired slot (e.g. filling in the
   * real driver/wss once the Appium session has actually started, or
   * renaming the slot's key once the real sessionId is known via
   * rekey()).
   */
  update(sessionKey, patch) {
    const existing = this.slots.get(sessionKey);
    if (!existing) throw new Error(`No session pool slot keyed "${sessionKey}".`);
    Object.assign(existing, patch);
  }

  /**
   * Moves a slot from a temporary key (assigned before the real Appium
   * sessionId was known) to its final key, preserving its data.
   */
  rekey(oldKey, newKey) {
    if (oldKey === newKey) return;
    const existing = this.slots.get(oldKey);
    if (!existing) throw new Error(`No session pool slot keyed "${oldKey}".`);
    if (this.slots.has(newKey)) throw new Error(`Session pool already has a slot keyed "${newKey}".`);
    this.slots.delete(oldKey);
    this.slots.set(newKey, existing);
  }

  release(sessionKey) {
    this.slots.delete(sessionKey);
  }

  get(sessionKey) {
    return this.slots.get(sessionKey);
  }

  /** All active slots, each annotated with its sessionKey. */
  list() {
    return Array.from(this.slots.entries(), ([sessionKey, slot]) => ({ sessionKey, ...slot }));
  }
}

module.exports = { SessionPool, SessionPoolFullError, DEFAULT_CAPACITY, DEFAULT_BASE_PORT };
