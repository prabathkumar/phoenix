/**
 * page-memory.js -- remembers what each page (and each state a page passes through)
 * looked like: the short list of controls Phoenix saw, plus a fingerprint of it.
 *
 * Why: pages change as you use them (the contract-period buttons only exist after the
 * plan is picked) and sites change between releases. Remembering each state lets Phoenix
 * say "this page is not what it was last run: 'NEXT' is gone, 'Continue' is new" instead
 * of passing or failing for a reason nobody can see, and gives the next feature
 * (replaying a recorded journey without the model) something to stand on.
 *
 * What is stored is the distilled control list, never raw HTML: it is small, readable,
 * and is what the model is given anyway. SQLite via node:sqlite, same as locator-store.
 * Deleting the file only resets history; a run never depends on it, and every call here
 * is best-effort (an error is swallowed so a memory problem can never fail a test).
 */
const crypto = require("crypto");

const dbFile = () => process.env.TESTOPS_MOBILE_PAGE_DB_PATH
  || (process.env.TESTOPS_MOBILE_LOCATOR_DB_PATH ? require("path").join(require("path").dirname(process.env.TESTOPS_MOBILE_LOCATOR_DB_PATH), "page-memory.db") : "page-memory.db");

/** Same page whatever the product id, query string or fragment: digits/uuids collapse. */
function pageKey(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "").split("/").map((seg) => (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg) || /^\d+$/.test(seg) ? ":id" : seg)).join("/");
    return `${u.origin}${path || "/"}`;
  } catch { return String(url || ""); }
}

/** One short line per control; numbers in names are dropped ("581 People viewing" changes every load). */
function lineOf(e) {
  const name = String(e.name || e.placeholder || e.id || "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 60);
  return `${e.role || e.tag || "?"}|${name}`;
}

function controlsOf(elements) {
  return [...new Set((elements || []).filter((e) => e && (e.name || e.placeholder || e.id)).map(lineOf))].sort();
}

function fingerprint(controls) {
  return crypto.createHash("sha1").update(controls.join("\n")).digest("hex").slice(0, 12);
}

function open(file = dbFile()) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS page_states (
    page TEXT NOT NULL, fingerprint TEXT NOT NULL, controls TEXT NOT NULL,
    seen INTEGER NOT NULL DEFAULT 1, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
    PRIMARY KEY (page, fingerprint));`);
  return db;
}

/**
 * Record what the page looks like now. Returns {known, fingerprint, drift}:
 *   known  -- this exact state was seen before
 *   drift  -- when the page has been seen before in a *different* state, how the closest
 *             remembered state differs ({added, removed}); null when nothing to compare
 * Never throws.
 */
function observe(url, elements, { file } = {}) {
  try {
    const db = open(file);
    try {
      const page = pageKey(url), controls = controlsOf(elements), fp = fingerprint(controls), now = new Date().toISOString();
      const row = db.prepare("SELECT seen FROM page_states WHERE page=? AND fingerprint=?").get(page, fp);
      if (row) {
        db.prepare("UPDATE page_states SET seen=seen+1, last_seen=? WHERE page=? AND fingerprint=?").run(now, page, fp);
        return { known: true, page, fingerprint: fp, drift: null };
      }
      // closest remembered state = the one sharing most controls
      let best = null;
      for (const r of db.prepare("SELECT fingerprint, controls FROM page_states WHERE page=?").all(page)) {
        const old = JSON.parse(r.controls), shared = old.filter((c) => controls.includes(c)).length;
        const score = shared / Math.max(old.length, controls.length, 1);
        if (!best || score > best.score) best = { score, old };
      }
      db.prepare("INSERT INTO page_states (page, fingerprint, controls, first_seen, last_seen) VALUES (?,?,?,?,?)").run(page, fp, JSON.stringify(controls), now, now);
      const drift = best && best.score >= 0.5 ? {
        added: controls.filter((c) => !best.old.includes(c)).slice(0, 12),
        removed: best.old.filter((c) => !controls.includes(c)).slice(0, 12),
      } : null;
      return { known: false, page, fingerprint: fp, drift };
    } finally { db.close(); }
  } catch { return null; }
}

/** Plain sentence for the UI: empty when nothing to say. */
function describe(obs) {
  if (!obs || obs.known || !obs.drift || (!obs.drift.added.length && !obs.drift.removed.length)) return "";
  const nice = (l) => `"${l.split("|")[1]}"`;
  const parts = [];
  if (obs.drift.removed.length) parts.push(`gone: ${obs.drift.removed.slice(0, 4).map(nice).join(", ")}`);
  if (obs.drift.added.length) parts.push(`new: ${obs.drift.added.slice(0, 4).map(nice).join(", ")}`);
  return `this page differs from the last time it was seen (${parts.join("; ")})`;
}

module.exports = { pageKey, controlsOf, fingerprint, observe, describe };
