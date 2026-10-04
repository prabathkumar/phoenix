/**
 * locator-store.js -- an embedded, zero-ops locator database, additive
 * to (never a replacement for) the pinned `resolvedSelector` already
 * committed in each test-case JSON file.
 *
 * Why this exists, and why it's SQLite and not ClickHouse/Chroma: the
 * actual access pattern here is a point lookup/upsert keyed by
 * (test case, step index) against a few hundred rows, written one at a
 * time during a live test run -- not an analytics scan over billions
 * of rows (ClickHouse) and not a semantic-similarity search over
 * embeddings (Chroma/vector DB; a real future use case -- "reuse a
 * selector for a differently-worded but equivalent instruction" -- but
 * a DIFFERENT feature from what this file does). `node:sqlite` is
 * built into Node 22+: no server, no native-module install, no extra
 * dependency in package.json, just one file on disk
 * (TESTOPS_MOBILE_LOCATOR_DB_PATH, default `locator-store.db` at the repo
 * root) -- as lightweight as this problem actually is.
 *
 * What this DOES that the JSON file alone can't:
 *   - Tracks confidence over time: how many times a selector has been
 *     confirmed correct (verified hit) vs. merely "didn't throw"
 *     (unverified), and how many times it's had to be re-resolved
 *     (a drift/miss) -- the regression-suite-health question from
 *     docs/STATUS.md's "is our regression suite rotting" gap.
 *   - Gives the confidence-gate (engine/test-case-runner.js's
 *     runScriptSteps) a place to record "this fresh resolution has NOT
 *     been verified yet, don't trust it blindly" without having to
 *     encode that state in the committed JSON file itself.
 *   - A queryable rollup across every test case in one place, which a
 *     directory of individual JSON files was never meant to answer.
 *
 * What this explicitly does NOT do: it is not the source of truth for
 * what a real run actually plays back. `resolvedSelector` in the
 * test-case JSON stays the fast-path, git-diffable, human-reviewable
 * cache a run reads first (see engine/test-case-runner.js's own doc
 * comment) -- this store is a confidence/analytics layer alongside it,
 * safe to delete and rebuild at any time with zero effect on test
 * behavior (deleting the DB file just resets confidence history, it
 * never breaks a run -- the JSON file alone is always enough to run a
 * test case).
 */

const path = require("path");

function dbPath() {
  return process.env.TESTOPS_MOBILE_LOCATOR_DB_PATH || path.join(process.cwd(), "locator-store.db");
}

/**
 * Opens (creating if needed) the locator store at `filePath` (defaults
 * to dbPath()). Lazily requires `node:sqlite` so nothing that doesn't
 * use this module ever pays for it or sees its experimental-feature
 * warning.
 *
 * @param {string} [filePath]
 * @returns {{db: Object, close: Function}}
 */
function openLocatorStore(filePath = dbPath()) {
  // eslint-disable-next-line global-require
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS locators (
      test_case TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      instruction TEXT NOT NULL,
      strategy TEXT NOT NULL,
      value TEXT NOT NULL,
      verified_hits INTEGER NOT NULL DEFAULT 0,
      unverified_hits INTEGER NOT NULL DEFAULT 0,
      misses INTEGER NOT NULL DEFAULT 0,
      last_verified_at TEXT,
      last_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (test_case, step_index)
    );
  `);
  return { db, close: () => db.close() };
}

/**
 * Records the outcome of one step's resolution attempt during a real
 * run. Called for EVERY step that has a selector, whether it came from
 * the pinned cache (`usedCache: true`) or was freshly resolved this
 * run -- the store's whole value is tracking both over time.
 *
 * `verified` means: real, concrete evidence this selector did the
 * right thing -- the step declared an `expect` and it was confirmed, or
 * (no `expect` declared) a real, non-empty diff was observed. Matches
 * exactly the same confidence bar runScriptSteps' own persistence gate
 * uses for whether to pin a fresh resolution into the JSON file --
 * deliberately the same bar, not a second, different one.
 *
 * - A verified hit increments `verified_hits` and stamps
 *   `last_verified_at`.
 * - An unverified-but-successful resolution (no WebDriver error, but
 *   no concrete evidence either) increments `unverified_hits` --
 *   visible in reports as "ran, but nothing confirmed it was right."
 * - `usedCache: false` with a DIFFERENT selector value than the row
 *   already on file means the pinned selector just drifted -- recorded
 *   as a miss on the OLD row's behalf isn't attempted here (this
 *   function only ever upserts the CURRENT attempt's row); drift is
 *   instead visible as a `verified_hits`/`unverified_hits` counter
 *   reset on a changed `value` for the same (test_case, step_index) --
 *   intentional: a changed selector is a new thing to (re)earn
 *   confidence in, not a continuation of the old one's track record.
 *
 * @param {{db: Object}} store
 * @param {{testCaseFile: string, stepIndex: number, instruction: string, selector: {strategy: string, value: string}, verified: boolean}} attempt
 */
function recordResolution(store, { testCaseFile, stepIndex, instruction, selector, verified }) {
  const now = new Date().toISOString();
  const existing = store.db
    .prepare(`SELECT * FROM locators WHERE test_case = ? AND step_index = ?`)
    .get(testCaseFile, stepIndex);

  const sameValue = existing && existing.strategy === selector.strategy && existing.value === selector.value;

  const verifiedHits = (sameValue ? existing.verified_hits : 0) + (verified ? 1 : 0);
  const unverifiedHits = (sameValue ? existing.unverified_hits : 0) + (verified ? 0 : 1);
  const misses = sameValue ? existing.misses : (existing ? existing.misses + 1 : 0);

  store.db
    .prepare(
      `INSERT INTO locators (test_case, step_index, instruction, strategy, value, verified_hits, unverified_hits, misses, last_verified_at, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(test_case, step_index) DO UPDATE SET
         instruction = excluded.instruction,
         strategy = excluded.strategy,
         value = excluded.value,
         verified_hits = excluded.verified_hits,
         unverified_hits = excluded.unverified_hits,
         misses = excluded.misses,
         last_verified_at = excluded.last_verified_at,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at`
    )
    .run(
      testCaseFile,
      stepIndex,
      instruction,
      selector.strategy,
      selector.value,
      verifiedHits,
      unverifiedHits,
      misses,
      verified ? now : (sameValue ? existing.last_verified_at : null) || null,
      now,
      now
    );
}

/**
 * Returns every row for one test case, ordered by step_index -- the
 * raw data behind a "how healthy is this regression suite" report.
 * @param {{db: Object}} store
 * @param {string} testCaseFile
 */
function getLocatorStats(store, testCaseFile) {
  return store.db
    .prepare(`SELECT * FROM locators WHERE test_case = ? ORDER BY step_index ASC`)
    .all(testCaseFile);
}

/**
 * Returns every row in the store, across all test cases -- the
 * suite-wide rollup (e.g. "which selectors have drifted the most").
 * @param {{db: Object}} store
 */
function getAllLocatorStats(store) {
  return store.db.prepare(`SELECT * FROM locators ORDER BY test_case ASC, step_index ASC`).all();
}

module.exports = {
  dbPath,
  openLocatorStore,
  recordResolution,
  getLocatorStats,
  getAllLocatorStats,
};
