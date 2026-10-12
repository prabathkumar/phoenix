/**
 * The `api` step: one HTTP call made from inside any flow (web or mobile),
 * with checks on the response and values saved for later steps. Typical use:
 * after a UI step, call an endpoint to confirm the database really changed.
 *
 * {
 *   "kind": "api",
 *   "instruction": "Order exists in the DB",          // optional label
 *   "method": "GET",                                   // default GET
 *   "url": "https://api.example.com/orders/${ORDER_ID}",  // relative URLs join baseUrl
 *   "headers": { "Authorization": "Bearer ${API_TOKEN}" },
 *   "body": { "any": "json" }  |  "raw string",
 *   "expect": {
 *     "status": 200,                                   // number or [numbers]
 *     "json": [ { "path": "$.status", "equals": "PAID" },
 *               { "path": "$.items", "exists": true },
 *               { "path": "$.email", "contains": "@" } ],
 *     "bodyContains": "PAID",
 *     "maxMs": 2000
 *   },
 *   "save": { "ORDER_ID": "$.id" }                     // later steps use ${ORDER_ID}
 * }
 */
const { readPath } = require("./json-path");
const { interpolate, interpolateDeep } = require("./vars");

const DEFAULT_TIMEOUT_MS = 15000;
const SECRET_HEADER_RE = /authorization|cookie|token|key|secret|password/i;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

/** Returns an error message, or undefined when the step is well formed. */
function validateApiStep(step) {
  if (!step || typeof step !== "object") return "is not an object";
  if (typeof step.url !== "string" || !step.url.trim()) return 'is an "api" step with no "url"';
  const method = String(step.method || "GET").toUpperCase();
  if (!METHODS.has(method)) return `has an unsupported "method" (${step.method})`;
  if (step.expect !== undefined) {
    const e = step.expect;
    if (!e || typeof e !== "object" || Array.isArray(e)) return 'has an invalid "expect" (must be an object)';
    if (e.json !== undefined && (!Array.isArray(e.json) || e.json.some((c) => !c || typeof c.path !== "string"))) {
      return 'has an invalid "expect.json" (must be a list of {path, equals|contains|exists})';
    }
  }
  if (step.save !== undefined) {
    if (!step.save || typeof step.save !== "object" || Array.isArray(step.save) ||
        Object.entries(step.save).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== "string")) {
      return 'has an invalid "save" (must map VARIABLE_NAME to a JSON path)';
    }
  }
  return undefined;
}

function redactHeaders(headers) {
  return Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k, SECRET_HEADER_RE.test(k) ? "***" : v]));
}

const same = (a, b) => (typeof a === "object" || typeof b === "object" ? JSON.stringify(a) === JSON.stringify(b) : String(a) === String(b));

function runChecks(expect, response, durationMs) {
  const problems = [];
  if (expect.status !== undefined) {
    const allowed = Array.isArray(expect.status) ? expect.status : [expect.status];
    if (!allowed.includes(response.status)) problems.push(`expected status ${allowed.join(" or ")} but got ${response.status}`);
  }
  if (expect.maxMs !== undefined && durationMs > expect.maxMs) problems.push(`took ${durationMs} ms, over the ${expect.maxMs} ms limit`);
  if (expect.bodyContains !== undefined && !response.text.includes(String(expect.bodyContains))) {
    problems.push(`body does not contain "${expect.bodyContains}"`);
  }
  for (const check of expect.json || []) {
    if (response.json === undefined) { problems.push(`${check.path}: response is not JSON`); continue; }
    const hit = readPath(response.json, check.path);
    if (check.exists === false) { if (hit.found) problems.push(`${check.path}: expected to be absent but is present`); continue; }
    if (!hit.found) { problems.push(`${check.path}: not found in the response`); continue; }
    if ("equals" in check && !same(hit.value, check.equals)) problems.push(`${check.path}: expected ${JSON.stringify(check.equals)} but got ${JSON.stringify(hit.value)}`);
    if ("contains" in check && !String(typeof hit.value === "object" ? JSON.stringify(hit.value) : hit.value).includes(String(check.contains))) {
      problems.push(`${check.path}: ${JSON.stringify(hit.value)} does not contain ${JSON.stringify(check.contains)}`);
    }
    if ("matches" in check && !new RegExp(check.matches).test(String(hit.value))) problems.push(`${check.path}: ${JSON.stringify(hit.value)} does not match /${check.matches}/`);
  }
  return problems;
}

/**
 * @param {Object} step
 * @param {{vars?: Object, env?: Object, baseUrl?: string, fetchFn?: Function}} [ctx]
 *   `vars` is mutated: saved values are written into it for later steps.
 * @returns {Promise<{ok: boolean, status?: number, durationMs: number, reason?: string,
 *   request: Object, response?: {status: number, bodyPreview: string, json?: any}, saved: Object}>}
 */
async function executeApiStep(step, ctx = {}) {
  const vars = ctx.vars || (ctx.vars = {});
  const fetchFn = ctx.fetchFn || fetch;
  const started = Date.now();
  const bad = validateApiStep(step);
  if (bad) return { ok: false, durationMs: 0, reason: `api step ${bad}`, request: {}, saved: {} };

  let request;
  try {
    const method = String(step.method || "GET").toUpperCase();
    let url = interpolate(step.url, ctx);
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      if (!ctx.baseUrl) throw new Error(`relative URL "${url}" needs a baseUrl`);
      url = new URL(url, ctx.baseUrl).toString();
    }
    const headers = interpolateDeep(step.headers || {}, ctx);
    let body;
    if (step.body !== undefined && method !== "GET" && method !== "HEAD") {
      if (typeof step.body === "string") body = interpolate(step.body, ctx);
      else {
        body = JSON.stringify(interpolateDeep(step.body, ctx));
        if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
      }
    }
    request = { method, url, headers, body };
  } catch (err) {
    return { ok: false, durationMs: Date.now() - started, reason: err.message, request: {}, saved: {} };
  }
  const shownRequest = { method: request.method, url: request.url, headers: redactHeaders(request.headers) };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), step.timeoutMs || DEFAULT_TIMEOUT_MS);
  let response;
  try {
    const res = await fetchFn(request.url, { method: request.method, headers: request.headers, body: request.body, signal: controller.signal });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    response = { status: res.status, text, json };
  } catch (err) {
    clearTimeout(timer);
    const reason = err.name === "AbortError" ? `request timed out after ${step.timeoutMs || DEFAULT_TIMEOUT_MS} ms` : `request failed: ${err.message}`;
    return { ok: false, durationMs: Date.now() - started, reason, request: shownRequest, saved: {} };
  }
  clearTimeout(timer);
  const durationMs = Date.now() - started;
  const shownResponse = { status: response.status, bodyPreview: response.text.slice(0, 600), ...(response.json !== undefined ? { json: response.json } : {}) };

  // With no explicit checks a call must at least succeed (2xx), so a bare
  // "call this endpoint" step still fails on a 500.
  const expect = step.expect || { status: undefined };
  const problems = step.expect ? runChecks(expect, response, durationMs) : (response.status >= 200 && response.status < 300 ? [] : [`got HTTP ${response.status}`]);

  const saved = {};
  if (!problems.length) {
    for (const [name, path] of Object.entries(step.save || {})) {
      let value;
      if (path === "status") value = response.status;
      else if (path.startsWith("header:")) value = undefined;
      else {
        const hit = response.json === undefined ? { found: false } : readPath(response.json, path);
        if (!hit.found) { problems.push(`save ${name}: ${path} not found in the response`); continue; }
        value = hit.value;
      }
      saved[name] = value;
      vars[name] = value;
    }
  }
  return {
    ok: problems.length === 0,
    status: response.status,
    durationMs,
    ...(problems.length ? { reason: problems.join("; ") } : {}),
    request: shownRequest,
    response: shownResponse,
    saved,
  };
}

module.exports = { executeApiStep, validateApiStep };
