const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { test } = require("node:test");

const { openLocatorStore, recordResolution, getLocatorStats, getAllLocatorStats } = require("../locator-store");

function tmpDbPath() {
  return path.join(os.tmpdir(), `phoenix-locator-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
}

test("openLocatorStore creates a fresh, empty store", () => {
  const dbPath = tmpDbPath();
  const store = openLocatorStore(dbPath);
  try {
    assert.deepStrictEqual(getAllLocatorStats(store), []);
  } finally {
    store.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("recordResolution inserts a new row with verified_hits=1 on a verified attempt", () => {
  const dbPath = tmpDbPath();
  const store = openLocatorStore(dbPath);
  try {
    recordResolution(store, {
      testCaseFile: "addons.ios.json",
      stepIndex: 0,
      instruction: "tap Allow",
      selector: { strategy: "accessibility-id", value: "Allow" },
      verified: true,
    });
    const rows = getLocatorStats(store, "addons.ios.json");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].verified_hits, 1);
    assert.strictEqual(rows[0].unverified_hits, 0);
    assert.strictEqual(rows[0].misses, 0);
    assert.ok(rows[0].last_verified_at, "last_verified_at should be stamped");
  } finally {
    store.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("recordResolution accumulates verified_hits across repeated identical resolutions (stable selector)", () => {
  const dbPath = tmpDbPath();
  const store = openLocatorStore(dbPath);
  try {
    const attempt = {
      testCaseFile: "addons.ios.json",
      stepIndex: 0,
      instruction: "tap Allow",
      selector: { strategy: "accessibility-id", value: "Allow" },
      verified: true,
    };
    recordResolution(store, attempt);
    recordResolution(store, attempt);
    recordResolution(store, attempt);
    const rows = getLocatorStats(store, "addons.ios.json");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].verified_hits, 3);
  } finally {
    store.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("recordResolution with verified:false increments unverified_hits, not verified_hits, and leaves last_verified_at unset", () => {
  const dbPath = tmpDbPath();
  const store = openLocatorStore(dbPath);
  try {
    recordResolution(store, {
      testCaseFile: "addons.ios.json",
      stepIndex: 2,
      instruction: "tap something unverified",
      selector: { strategy: "accessibility-id", value: "Maybe" },
      verified: false,
    });
    const rows = getLocatorStats(store, "addons.ios.json");
    assert.strictEqual(rows[0].verified_hits, 0);
    assert.strictEqual(rows[0].unverified_hits, 1);
    assert.strictEqual(rows[0].last_verified_at, null);
  } finally {
    store.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("recordResolution with a CHANGED selector value resets the hit counters and records a miss (drift signal)", () => {
  const dbPath = tmpDbPath();
  const store = openLocatorStore(dbPath);
  try {
    recordResolution(store, {
      testCaseFile: "addons.ios.json",
      stepIndex: 1,
      instruction: "tap LOGIN",
      selector: { strategy: "accessibility-id", value: "LOGIN" },
      verified: true,
    });
    recordResolution(store, {
      testCaseFile: "addons.ios.json",
      stepIndex: 1,
      instruction: "tap LOGIN",
      selector: { strategy: "accessibility-id", value: "LOGIN_NEW" }, // the app renamed the id
      verified: true,
    });
    const rows = getLocatorStats(store, "addons.ios.json");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].value, "LOGIN_NEW");
    assert.strictEqual(rows[0].verified_hits, 1, "history resets for the new selector value, not accumulated across a drift");
    assert.strictEqual(rows[0].misses, 1, "the drift itself is counted");
  } finally {
    store.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("getLocatorStats only returns rows for the requested test case, ordered by step_index", () => {
  const dbPath = tmpDbPath();
  const store = openLocatorStore(dbPath);
  try {
    recordResolution(store, { testCaseFile: "a.json", stepIndex: 1, instruction: "x", selector: { strategy: "accessibility-id", value: "X" }, verified: true });
    recordResolution(store, { testCaseFile: "a.json", stepIndex: 0, instruction: "y", selector: { strategy: "accessibility-id", value: "Y" }, verified: true });
    recordResolution(store, { testCaseFile: "b.json", stepIndex: 0, instruction: "z", selector: { strategy: "accessibility-id", value: "Z" }, verified: true });

    const aRows = getLocatorStats(store, "a.json");
    assert.strictEqual(aRows.length, 2);
    assert.strictEqual(aRows[0].step_index, 0);
    assert.strictEqual(aRows[1].step_index, 1);

    const bRows = getLocatorStats(store, "b.json");
    assert.strictEqual(bRows.length, 1);
  } finally {
    store.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("getAllLocatorStats returns rows across every test case", () => {
  const dbPath = tmpDbPath();
  const store = openLocatorStore(dbPath);
  try {
    recordResolution(store, { testCaseFile: "a.json", stepIndex: 0, instruction: "x", selector: { strategy: "accessibility-id", value: "X" }, verified: true });
    recordResolution(store, { testCaseFile: "b.json", stepIndex: 0, instruction: "z", selector: { strategy: "accessibility-id", value: "Z" }, verified: false });
    const all = getAllLocatorStats(store);
    assert.strictEqual(all.length, 2);
    assert.deepStrictEqual(all.map((r) => r.test_case).sort(), ["a.json", "b.json"]);
  } finally {
    store.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("the store persists to disk -- reopening the same file sees prior data", () => {
  const dbPath = tmpDbPath();
  try {
    const store1 = openLocatorStore(dbPath);
    recordResolution(store1, { testCaseFile: "a.json", stepIndex: 0, instruction: "x", selector: { strategy: "accessibility-id", value: "X" }, verified: true });
    store1.close();

    const store2 = openLocatorStore(dbPath);
    const rows = getLocatorStats(store2, "a.json");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].value, "X");
    store2.close();
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});
