/**
 * The test-data layer: decides, BEFORE a run starts, where every ${NAME}
 * value comes from - and never invents what only the system under test can
 * supply.
 *
 *   generated     the layer makes it up (email, phone, date, amount, a NEW
 *                 user's password, free text, ...) in the format the system needs
 *   provided      the tester typed it, picked a saved value, or uploaded a file
 *   needs-you     it must already exist in the system (a login, an existing
 *                 customer id, an OTP, an API token) so it cannot be made up
 *   negative-only the tester chose "skip": deliberately wrong values are used
 *                 so only the bad-login style cases can run
 *
 * It sits under both the Synthetic and Semantic layers (docs/TEST_DATA.md):
 * the output is a plain { NAME: value } map, the same `testData` every runner
 * already takes. Generation is deterministic from a seed, so a run can be
 * repeated exactly; nothing here calls a model or the network.
 */
const { isSecretName } = require("./english");

const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SECRET_MASK = "••••••";

// ---------------------------------------------------------------- seeded random
function hashSeed(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/** mulberry32: small, fast, good enough for test data. One generator per (seed, field, variant). */
function rngFor(...parts) {
  let a = hashSeed(parts.join("\u0001"));
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const pick = (r, list) => list[int(r, 0, list.length - 1)];
const hex = (r, n) => Array.from({ length: n }, () => "0123456789abcdef"[int(r, 0, 15)]).join("");
const pad = (n, w) => String(n).padStart(w, "0");

// ---------------------------------------------------------------- classification
const KIND_RULES = [
  ["password", /(pass(word)?|pwd)/i],
  ["otp", /(^|_)(otp|tac|pin|cvv)(_|$)/i],
  ["token", /(token|api_?key|secret|bearer)/i],
  ["email", /e_?mail/i],
  ["phone", /(phone|mobile|msisdn|contact_?no|(^|_)tel(_|$))/i],
  ["username", /(user_?name|(^|_)user(_|$)|login(_?id)?$|account(_?no|_?number)?$)/i],
  ["date", /(date|dob|birth|expiry|expire)/i],
  ["amount", /(amount|price|total|balance|qty|quantity|(^|_)count(_|$))/i],
  ["name", /(first_?name|last_?name|full_?name|^name$|_name$)/i],
  ["reference", /((^|_)id$|^id_|ref(erence)?(_|$)|order_?(no|number)|customer|member|policy)/i],
];

/** camelCase / kebab-case / spaced -> SNAKE_CASE (keys from JSON bodies and form labels). */
const snake = (key) => String(key).replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * @param {string} name   the placeholder name, e.g. LOGIN_PASSWORD
 * @param {{kind?:string, existing?:boolean}} [hint]
 * @returns {{name:string, kind:string, secret:boolean, mustExist:boolean, reason:string}}
 */
function classify(name, hint = {}) {
  const n = snake(name);
  const kind = hint.kind || (KIND_RULES.find(([, re]) => re.test(n)) || ["text"])[0];
  const fresh = hint.existing === false || /(^|_)(new|signup|register|random|fake|sample)(_|$)/i.test(n);
  const named = hint.existing === true || /(^|_)(login|existing|registered|valid)(_|$)/i.test(n);
  // An OTP or token is issued by the system, so it can never be made up, new or not.
  const issued = kind === "otp" || kind === "token";
  const lookup = !fresh && (kind === "password" || kind === "username" || kind === "reference");
  const mustExist = hint.existing === false && !issued ? false : issued || (!fresh && (named || lookup));
  let reason = "";
  if (mustExist) {
    reason = kind === "otp" ? "A one-time code is sent by your system, so it cannot be made up."
      : kind === "token" ? "Only your system can issue it."
      : kind === "reference" ? "It has to match a record that already exists in your system."
      : "The account has to already exist in your system, with exactly these details.";
  }
  return { name, kind, secret: isSecretName(name), mustExist, reason };
}

// ---------------------------------------------------------------- generators
/** Template language: # digit, ? lowercase letter, A uppercase letter, * letter or digit; anything else is literal. */
function fromTemplate(fmt, r) {
  return String(fmt).replace(/[#?A*]/g, (c) =>
    c === "#" ? String(int(r, 0, 9))
    : c === "?" ? "abcdefghijklmnopqrstuvwxyz"[int(r, 0, 25)]
    : c === "A" ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[int(r, 0, 25)]
    : "abcdefghijklmnopqrstuvwxyz0123456789"[int(r, 0, 35)]);
}

const FIRST = ["Aiden", "Mei", "Rahul", "Siti", "Daniel", "Priya", "Wei", "Aisha", "Lucas", "Nur", "Kavin", "Hana"];
const LAST = ["Tan", "Lim", "Kumar", "Rahman", "Wong", "Nair", "Chen", "Ismail", "Lee", "Raj", "Ong", "Das"];

// Number ranges set aside for fiction, so a generated number never belongs to a real person.
const PHONE = {
  US: (r) => `202-555-01${pad(int(r, 0, 99), 2)}`,
  GB: (r) => `07700 900${pad(int(r, 0, 999), 3)}`,
};

function pad2(n) { return pad(n, 2); }
function formatDate(d, fmt) {
  return String(fmt).replace(/YYYY/g, d.getUTCFullYear()).replace(/MM/g, pad2(d.getUTCMonth() + 1)).replace(/DD/g, pad2(d.getUTCDate()));
}
const DAY = 86400000;
function randomDate(r, lo, hi) { return new Date(lo + Math.floor(r() * ((hi - lo) / DAY)) * DAY); }

function strongPassword(r, length = 14) {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%^&*"];
  const all = sets.join("");
  const chars = sets.map((s) => pick(r, [...s]));
  while (chars.length < Math.max(length, 8)) chars.push(pick(r, [...all]));
  for (let i = chars.length - 1; i > 0; i -= 1) { const j = int(r, 0, i); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join("");
}

function validValue(info, hint, r) {
  if (hint.format) return fromTemplate(hint.format, r);
  if (Array.isArray(hint.enum) && hint.enum.length) return String(pick(r, hint.enum));
  switch (info.kind) {
    case "email": return `qa.${hex(r, 8)}@${hint.domain || "example.com"}`;
    case "phone": return (PHONE[hint.country] || PHONE.US)(r);
    case "username": return `qa_user_${hex(r, 6)}`;
    case "password": return strongPassword(r, hint.length || 14);
    case "name": return /first/i.test(info.name) ? pick(r, FIRST) : /last/i.test(info.name) ? pick(r, LAST) : `${pick(r, FIRST)} ${pick(r, LAST)}`;
    case "date": {
      const birth = /dob|birth/i.test(info.name);
      const lo = Date.UTC(birth ? 1960 : 2024, 0, 1), hi = Date.UTC(birth ? 2002 : 2030, 11, 28);
      return formatDate(randomDate(r, lo, hi), hint.dateFormat || "YYYY-MM-DD");
    }
    case "amount": {
      const lo = hint.min ?? 1, hi = hint.max ?? 1000;
      const decimals = hint.decimals ?? (/(amount|price|total|balance)/i.test(info.name) ? 2 : 0);
      const v = lo + r() * (hi - lo);
      return decimals ? v.toFixed(decimals) : String(Math.round(v));
    }
    case "reference": return `NEW-${pad(int(r, 0, 999999), 6)}`;
    default: return `Sample text ${hex(r, 4)}`;
  }
}

const WRONG_FORMAT = {
  email: "not-an-email", phone: "12-ab", date: "31/31/9999", amount: "abc", reference: "!!bad id!!",
  username: "bad user!!", password: "x", otp: "abc", token: "not a token", name: "1234 !!",
};

/**
 * One value for one field.
 * variant: valid | empty | tooLong | wrongFormat | belowMin | aboveMax | invalidCredential
 * Returns undefined when the field must already exist and the variant is "valid" (the caller must ask).
 * @param {string} name
 * @param {Object} [hint] {kind, existing, format, enum, domain, country, dateFormat, min, max, decimals, length, maxLength}
 * @param {{seed?:string, variant?:string}} [opts]
 */
function generate(name, hint = {}, { seed = "default", variant = "valid" } = {}) {
  const info = classify(name, hint);
  const r = rngFor(seed, name, variant);
  switch (variant) {
    case "empty": return "";
    case "tooLong": return "x".repeat((hint.maxLength || 255) + 1);
    case "wrongFormat": return WRONG_FORMAT[info.kind] || "%%invalid%%";
    case "belowMin": return hint.min !== undefined ? String(hint.min - 1) : "-1";
    case "aboveMax": return hint.max !== undefined ? String(hint.max + 1) : "99999999999";
    case "invalidCredential":
      return info.kind === "otp" ? "000000"
        : info.kind === "password" ? `Wrong-${hex(r, 6)}!`
        : info.kind === "token" ? `invalid-${hex(r, 12)}`
        : info.kind === "reference" ? `NOT-${pad(int(r, 0, 999999), 6)}`
        : info.kind === "phone" ? PHONE.US(r)
        : `qa_nouser_${hex(r, 6)}`;
    default:
      if (info.mustExist && hint.existing !== false) return undefined;
      return validValue(info, hint, r);
  }
}

/** The set of values worth trying for a form field: one good value and the usual bad ones. */
function variantsFor(name, hint = {}, { seed = "default" } = {}) {
  const info = classify(name, hint);
  const list = ["valid", "empty", "tooLong", "wrongFormat"];
  if (info.kind === "amount") list.push("belowMin", "aboveMax");
  const out = {};
  for (const v of list) { const val = generate(name, hint, { seed, variant: v }); if (val !== undefined) out[v] = val; }
  return out;
}

// ---------------------------------------------------------------- API bodies
const SCHEMA_FORMAT_KIND = { email: "email", date: "date", "date-time": "date", uuid: "reference" };

/**
 * Fill a JSON request body. Works from a sample body (types are read from the
 * sample's values) and/or a small JSON-schema ({type, properties, enum, format,
 * minimum, maximum, maxLength, items}). Fields that must already exist (a
 * login, a token) are left as ${KEY} placeholders and listed in needsYou, so
 * the normal ${NAME} resolution supplies them at run time.
 * @returns {{body:any, needsYou:string[]}}
 */
function generateBody(sample, { schema, seed = "default", hints = {} } = {}) {
  const needsYou = [];
  const walk = (value, sch, key, path) => {
    const type = (sch && sch.type) || (Array.isArray(value) ? "array" : value === null ? "string" : typeof value);
    if (type === "object") {
      const props = (sch && sch.properties) || {};
      const keys = new Set([...Object.keys(props), ...Object.keys(value && typeof value === "object" ? value : {})]);
      return Object.fromEntries([...keys].map((k) => [k, walk(value && value[k], props[k], k, `${path}.${k}`)]));
    }
    if (type === "array") {
      const first = Array.isArray(value) && value.length ? value[0] : undefined;
      return [walk(first, sch && sch.items, key, `${path}[0]`)];
    }
    const name = snake(key || "value").toUpperCase();
    const hint = { ...(hints[name] || {}) };
    if (sch && sch.format && SCHEMA_FORMAT_KIND[sch.format] && !hint.kind) hint.kind = SCHEMA_FORMAT_KIND[sch.format];
    if (sch && sch.enum) hint.enum = sch.enum;
    if (sch && sch.maxLength) hint.maxLength = sch.maxLength;
    if (sch && sch.minimum !== undefined) hint.min = sch.minimum;
    if (sch && sch.maximum !== undefined) hint.max = sch.maximum;
    const info = classify(name, hint);
    if (info.mustExist && hint.existing !== false) { needsYou.push(name); return "${" + name + "}"; }
    if (type === "boolean") return rngFor(seed, path)() < 0.5;
    if (type === "integer" || type === "number" || (type !== "string" && typeof value === "number")) {
      const lo = hint.min ?? 1, hi = hint.max ?? 1000, r = rngFor(seed, path);
      const v = lo + r() * (hi - lo);
      return type === "integer" || Number.isInteger(value) ? Math.round(v) : Number(v.toFixed(2));
    }
    return validValue(info, hint, rngFor(seed, path));
  };
  const body = walk(sample, schema, "", "$");
  return { body, needsYou: [...new Set(needsYou)] };
}

/** Bad variants of a valid body: each leaf missing, empty, or the wrong type. */
function bodyMutations(body) {
  const out = [];
  const leaves = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
    else if (v && typeof v === "object") Object.keys(v).forEach((k) => walk(v[k], [...path, k]));
    else leaves.push(path);
  };
  walk(body, []);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const at = (root, path) => path.slice(0, -1).reduce((o, k) => o[k], root);
  const label = (p) => p.map((k) => (typeof k === "number" ? `[${k}]` : `.${k}`)).join("").replace(/^\./, "");
  for (const path of leaves) {
    const last = path[path.length - 1];
    const original = at(body, path)[last];
    const missing = clone(body);
    if (typeof last === "string") { delete at(missing, path)[last]; out.push({ name: `missing ${label(path)}`, body: missing }); }
    const wrong = clone(body);
    at(wrong, path)[last] = typeof original === "string" ? 12345 : typeof original === "number" ? "not-a-number" : "not-a-boolean";
    out.push({ name: `wrong type for ${label(path)}`, body: wrong });
    if (typeof original === "string") {
      const empty = clone(body);
      at(empty, path)[last] = "";
      out.push({ name: `empty ${label(path)}`, body: empty });
    }
  }
  return out;
}

// ---------------------------------------------------------------- which names a flow needs
function* stringsIn(value) {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const v of value) yield* stringsIn(v);
  else if (value && typeof value === "object") for (const v of Object.values(value)) yield* stringsIn(v);
}

/**
 * The ${NAME}s a flow needs from outside: every placeholder in the steps,
 * minus values an earlier api step saves, minus names already set in the
 * environment (the runners fall back to env, see engine/core/vars.js).
 * `steps` are English lines (strings) or test-case step objects.
 */
function requiredNames(steps, { env = process.env } = {}) {
  const saved = new Set();
  const seen = [];
  for (const step of steps || []) {
    for (const text of stringsIn(typeof step === "string" ? step : { ...step, save: undefined })) {
      for (const m of text.matchAll(PLACEHOLDER_RE)) if (!saved.has(m[1]) && !seen.includes(m[1])) seen.push(m[1]);
    }
    if (step && typeof step === "object" && step.save) Object.keys(step.save).forEach((k) => saved.add(k));
  }
  return seen.filter((n) => !(typeof env[n] === "string" && env[n].length));
}

// ---------------------------------------------------------------- api test-case steps
const NEGATIVE_STATUSES = [400, 401, 403, 404, 409, 415, 422];

/**
 * Opt-in per step: an api step with `"generateBody": true` has its `body` read
 * as a sample (plus optional `schema` and `hints`) and replaced with generated
 * values. Must-exist fields stay as ${NAME} and resolve like any test data.
 * Steps without the flag are returned untouched.
 * @returns {{steps:Object[], needsYou:string[]}}
 */
function prepareApiSteps(steps, { seed = "default" } = {}) {
  const needsYou = [];
  const out = (steps || []).map((step, i) => {
    if (!step || step.kind !== "api" || !step.generateBody) return step;
    const { body, needsYou: n } = generateBody(step.body === undefined ? {} : step.body, { schema: step.schema, hints: step.hints || {}, seed: `${seed}:${i}` });
    needsYou.push(...n);
    const { generateBody: _g, schema: _s, hints: _h, negative: _n, ...rest } = step;
    return { ...rest, body };
  });
  return { steps: out, needsYou: [...new Set(needsYou)] };
}

/**
 * Negative cases for api steps flagged `"negative": true` (with generateBody):
 * one case per bad body (a field missing, empty, or the wrong type). Each case
 * is a full step list where that one step expects a 4xx and nothing is saved.
 * @returns {{name:string, steps:Object[]}[]}
 */
function negativeApiCases(steps, { seed = "default", statuses = NEGATIVE_STATUSES } = {}) {
  const prepared = prepareApiSteps(steps, { seed }).steps;
  const cases = [];
  (steps || []).forEach((step, i) => {
    if (!step || step.kind !== "api" || !step.generateBody || !step.negative) return;
    const label = step.instruction || `${String(step.method || "GET").toUpperCase()} ${step.url}`;
    for (const m of bodyMutations(prepared[i].body)) {
      const { save: _save, ...rest } = prepared[i];
      const copy = prepared.map((x) => (x && x.kind === "api" ? { ...x } : x));
      copy[i] = { ...rest, instruction: `${label}: ${m.name}`, body: m.body, expect: { status: statuses } };
      cases.push({ name: `${label}: ${m.name}`, steps: copy.slice(0, i + 1) });
    }
  });
  return cases;
}

// ---------------------------------------------------------------- the plan
/**
 * @param {Object} opts
 * @param {string[]} opts.names                 placeholders the run needs (see requiredNames)
 * @param {Object}   [opts.hints]               { NAME: {kind, existing, format, ...} }
 * @param {Object}   [opts.provided]            values the tester typed, picked or uploaded
 * @param {"generate"|"upload"} [opts.mode]     generate: make up what can be made up
 * @param {boolean}  [opts.fill]                with mode "upload", still generate what the file leaves out (default true)
 * @param {Object}   [opts.choices]             { NAME: "saved"|"type"|"create"|"skip" } for needs-you fields
 * @param {boolean}  [opts.canCreate]           the app has a sign-up page or API for test users
 * @param {string}   [opts.seed]
 * @returns {{seed:string, values:Object, fields:Object[], needsYou:string[], ready:boolean}}
 */
function planTestData({ names, hints = {}, provided = {}, mode = "generate", fill = true, choices = {}, canCreate = false, seed = "default" }) {
  const values = {};
  const fields = [];
  for (const name of [...new Set(names || [])]) {
    const hint = hints[name] || {};
    const info = classify(name, hint);
    const given = provided[name];
    const base = { name, kind: info.kind, secret: info.secret, mustExist: info.mustExist };
    if (given !== undefined && given !== null && String(given) !== "") {
      values[name] = String(given);
      fields.push({ ...base, source: "provided" });
    } else if (choices[name] === "skip") {
      values[name] = generate(name, hint, { seed, variant: "invalidCredential" });
      fields.push({ ...base, source: "negative-only", reason: "Skipped: deliberately wrong values are used, so only the bad-login style cases can run." });
    } else if (info.mustExist || (mode === "upload" && !fill)) {
      const options = ["saved", "type", ...(canCreate || hint.canCreate ? ["create"] : []), "skip"];
      fields.push({ ...base, source: "needs-you", options, reason: info.mustExist ? info.reason : "Your file has no value for it." });
    } else {
      values[name] = generate(name, hint, { seed });
      fields.push({ ...base, source: "generated", ...(Object.keys(variantsFor(name, hint, { seed })).length > 1 ? { variants: variantsFor(name, hint, { seed }) } : {}) });
    }
  }
  const needsYou = fields.filter((f) => f.source === "needs-you").map((f) => f.name);
  return { seed, values, fields, needsYou, ready: needsYou.length === 0 };
}

/** The plan as a browser may see it: secret values (provided or generated) never leave the server. */
function describePlan(plan) {
  return {
    seed: plan.seed,
    ready: plan.ready,
    needsYou: plan.needsYou,
    fields: plan.fields.map((f) => {
      const v = plan.values[f.name];
      const { variants, ...rest } = f;
      return {
        ...rest,
        ...(v !== undefined ? { value: f.secret ? SECRET_MASK : v } : {}),
        ...(variants && !f.secret ? { variants } : {}),
      };
    }),
  };
}

// ---------------------------------------------------------------- uploaded files
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

/**
 * An uploaded test-data file -> { NAME: value }. Accepts
 *   JSON    {"LOGIN_PHONE":"...", ...}  or  [{"name":"LOGIN_PHONE","value":"..."}]
 *   CSV     header row of names + one row of values  (first row only)
 *   CSV     two columns named Name,Value
 * Throws an Error with a plain message when the file cannot be read.
 */
function parseUploaded(text) {
  const raw = String(text || "").replace(/^﻿/, "").trim();
  if (!raw) throw new Error("The test-data file is empty.");
  const flat = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v)).map(([k, v]) => [k, v === null ? "" : String(v)]));
  if (raw[0] === "{" || raw[0] === "[") {
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error("The test-data file looks like JSON but cannot be read."); }
    if (Array.isArray(data)) {
      if (!data.every((d) => d && typeof d.name === "string" && "value" in d)) throw new Error('A JSON list must look like [{"name": "...", "value": "..."}].');
      return Object.fromEntries(data.map((d) => [d.name, String(d.value ?? "")]));
    }
    return flat(data);
  }
  const rows = parseCsv(raw);
  if (rows.length < 2) throw new Error("The CSV needs a header row of names and a row of values.");
  const head = rows[0].map((h) => h.trim());
  if (head.length === 2 && head[0].toLowerCase() === "name" && head[1].toLowerCase() === "value") {
    return Object.fromEntries(rows.slice(1).filter((r) => r[0].trim()).map((r) => [r[0].trim(), r[1] ?? ""]));
  }
  return Object.fromEntries(head.map((h, i) => [h, rows[1][i] ?? ""]).filter(([h]) => h));
}

/** Names in an upload that no step uses, and names a step needs that the upload lacks. */
function checkUpload(upload, names) {
  return { unused: Object.keys(upload).filter((k) => !names.includes(k)), missing: names.filter((n) => upload[n] === undefined || upload[n] === "") };
}

// ---------------------------------------------------------------- saving and reloading
/**
 * What is safe to keep: the seed, the choices and the non-secret provided
 * values. Secret values are never written. Generated values (secret or not)
 * are rebuilt from the seed, so a reload repeats the same data.
 */
function toFile(plan, { choices = {} } = {}) {
  const provided = Object.fromEntries(plan.fields.filter((f) => f.source === "provided" && !f.secret).map((f) => [f.name, plan.values[f.name]]));
  return {
    layer: "testdata", version: 1, seed: plan.seed,
    names: plan.fields.map((f) => f.name),
    choices, values: provided,
    mustSupply: plan.fields.filter((f) => (f.source === "provided" || f.source === "needs-you") && f.secret).map((f) => f.name),
  };
}

function fromFile(file, { provided = {}, hints = {}, canCreate = false } = {}) {
  if (!file || file.layer !== "testdata" || file.version !== 1) throw new Error("This is not a test-data layer file.");
  return planTestData({ names: file.names, hints, provided: { ...file.values, ...provided }, choices: file.choices || {}, canCreate, seed: file.seed });
}

module.exports = {
  classify, generate, variantsFor, generateBody, bodyMutations,
  requiredNames, planTestData, describePlan, prepareApiSteps, negativeApiCases,
  parseUploaded, checkUpload, toFile, fromFile,
  fromTemplate, snake,
};
