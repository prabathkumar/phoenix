/**
 * Tests for session-pool.js — the slot/port bookkeeping SessionPool
 * does in isolation, with no real driver, WebSocket server, or process
 * env dependency unless a test explicitly exercises that default.
 *
 * Run with: npm test (from engine/) or `node test/session-pool.test.js`
 */

const assert = require("assert");
const { SessionPool, SessionPoolFullError } = require("../session-pool");

async function run(name, fn) {
  try {
    await fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function main() {
  console.log("engine/session-pool:");

  await run("defaults to capacity 1 and basePort 8090 with no options/env set", () => {
    const previousCapacity = process.env.PHOENIX_SESSION_POOL_SIZE;
    const previousPort = process.env.PHOENIX_LIVE_VIEW_PORT;
    delete process.env.PHOENIX_SESSION_POOL_SIZE;
    delete process.env.PHOENIX_LIVE_VIEW_PORT;
    try {
      const pool = new SessionPool();
      assert.strictEqual(pool.capacity, 1);
      assert.strictEqual(pool.basePort, 8090);
    } finally {
      if (previousCapacity !== undefined) process.env.PHOENIX_SESSION_POOL_SIZE = previousCapacity;
      if (previousPort !== undefined) process.env.PHOENIX_LIVE_VIEW_PORT = previousPort;
    }
  });

  await run("reads capacity/basePort from explicit options over env", () => {
    const pool = new SessionPool({ capacity: 3, basePort: 9000 });
    assert.strictEqual(pool.capacity, 3);
    assert.strictEqual(pool.basePort, 9000);
  });

  await run("hasCapacity() flips to false once slots fill up, true again after release", () => {
    const pool = new SessionPool({ capacity: 2, basePort: 9000 });
    assert.strictEqual(pool.hasCapacity(), true);
    pool.acquire("a", { port: pool.allocatePort(), platform: "android" });
    assert.strictEqual(pool.hasCapacity(), true);
    pool.acquire("b", { port: pool.allocatePort(), platform: "android" });
    assert.strictEqual(pool.hasCapacity(), false);
    pool.release("a");
    assert.strictEqual(pool.hasCapacity(), true);
  });

  await run("acquire() throws SessionPoolFullError once capacity is exceeded", () => {
    const pool = new SessionPool({ capacity: 1, basePort: 9000 });
    pool.acquire("a", { port: pool.allocatePort(), platform: "android" });
    assert.throws(
      () => pool.acquire("b", { port: pool.allocatePort(), platform: "android" }),
      SessionPoolFullError
    );
  });

  await run("allocatePort() hands out sequential distinct ports, skipping ones already held", () => {
    const pool = new SessionPool({ capacity: 3, basePort: 9000 });
    const portA = pool.allocatePort();
    pool.acquire("a", { port: portA, platform: "android" });
    const portB = pool.allocatePort();
    pool.acquire("b", { port: portB, platform: "android" });
    const portC = pool.allocatePort();

    assert.strictEqual(portA, 9000);
    assert.strictEqual(portB, 9001);
    assert.strictEqual(portC, 9002);

    // Releasing the middle slot frees its port back up for reuse.
    pool.release("b");
    assert.strictEqual(pool.allocatePort(), 9001);
  });

  await run("acquire() rejects a duplicate key even under capacity", () => {
    const pool = new SessionPool({ capacity: 5, basePort: 9000 });
    pool.acquire("dup", { port: 9000, platform: "android" });
    assert.throws(() => pool.acquire("dup", { port: 9001, platform: "android" }), /already has a slot/);
  });

  await run("rekey() moves a slot's data to a new key without losing it", () => {
    const pool = new SessionPool({ capacity: 2, basePort: 9000 });
    pool.acquire("pending-1", { port: 9000, platform: "android", driver: null });
    pool.update("pending-1", { driver: { sessionId: "real-session-1" } });
    pool.rekey("pending-1", "real-session-1");

    assert.strictEqual(pool.get("pending-1"), undefined);
    const slot = pool.get("real-session-1");
    assert.ok(slot);
    assert.strictEqual(slot.driver.sessionId, "real-session-1");
    assert.strictEqual(slot.port, 9000);
  });

  await run("list() reports every active slot with its key", () => {
    const pool = new SessionPool({ capacity: 2, basePort: 9000 });
    pool.acquire("a", { port: 9000, platform: "android" });
    pool.acquire("b", { port: 9001, platform: "ios" });
    const list = pool.list().sort((x, y) => x.sessionKey.localeCompare(y.sessionKey));
    assert.deepStrictEqual(
      list.map((s) => ({ sessionKey: s.sessionKey, platform: s.platform, port: s.port })),
      [
        { sessionKey: "a", platform: "android", port: 9000 },
        { sessionKey: "b", platform: "ios", port: 9001 },
      ]
    );
  });
}

main().then(() => {
  if (process.exitCode) {
    console.error("\nengine/session-pool tests FAILED");
    process.exit(1);
  } else {
    console.log("\nengine/session-pool tests passed");
  }
});
