/**
 * Emits an `api` step (see engine/core/api-step.js) as plain Node code for a
 * generated WebdriverIO script: global fetch + assertions, saved values
 * assigned to variables declared with `let` by the caller.
 */
const q = (v) => JSON.stringify(String(v));

const API_HELPERS = `function readPath(root, path) {
  const p = String(path).replace(/^\\$\\.?/, "");
  let cur = root;
  for (const m of p.matchAll(/([^.[\\]]+)|\\[(\\d+)\\]/g)) {
    const k = m[1] !== undefined ? m[1] : Number(m[2]);
    if (cur == null || typeof cur !== "object" || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}`;

/** "/orders/${ID}" -> template literal; known names are variables, others come from the environment. */
function toTemplate(text, known) {
  const body = String(text).replace(/\\/g, "\\\\").replace(/`/g, "\\`")
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => (known.has(n) ? "${" + n + "}" : "${process.env." + n + "}"));
  return "`" + body + "`";
}

function savedNames(steps) {
  return steps.filter((s) => s.kind === "api").flatMap((s) => Object.keys(s.save || {}));
}

function apiStepLines(s, known, indent = "    ") {
  const method = String(s.method || "GET").toUpperCase();
  const headers = Object.entries(s.headers || {});
  const opts = [`method: ${q(method)}`];
  const hdr = headers.map(([k, v]) => `${q(k)}: ${toTemplate(v, known)}`);
  if (s.body !== undefined && method !== "GET" && method !== "HEAD" && typeof s.body !== "string" &&
      !headers.some(([k]) => k.toLowerCase() === "content-type")) hdr.push(`"Content-Type": "application/json"`);
  if (hdr.length) opts.push(`headers: { ${hdr.join(", ")} }`);
  if (s.body !== undefined && method !== "GET" && method !== "HEAD") {
    opts.push(typeof s.body === "string" ? `body: ${toTemplate(s.body, known)}` : `body: JSON.stringify(${JSON.stringify(s.body)})`);
  }
  const e = s.expect || {};
  const out = [`${indent}// API: ${s.instruction || `${method} ${s.url}`}`, `${indent}{`];
  const i = indent + "  ";
  out.push(`${i}const res = await fetch(${toTemplate(s.url, known)}, { ${opts.join(", ")} });`);
  if (e.status !== undefined) {
    out.push(Array.isArray(e.status)
      ? `${i}expect(${JSON.stringify(e.status)}).toContain(res.status);`
      : `${i}expect(res.status).toBe(${e.status});`);
  } else if (!s.expect) out.push(`${i}expect(res.ok).toBe(true);`);
  const needsJson = (e.json && e.json.length) || Object.keys(s.save || {}).some((k) => s.save[k] !== "status");
  const needsText = e.bodyContains !== undefined;
  if (needsJson) out.push(`${i}const body = await res.json();`);
  if (needsText) out.push(`${i}expect(await res.text()).toContain(${q(e.bodyContains)});`);
  for (const c of e.json || []) {
    if (c.exists === false) out.push(`${i}expect(readPath(body, ${q(c.path)})).toBeUndefined();`);
    else if ("equals" in c) out.push(`${i}expect(readPath(body, ${q(c.path)})).toEqual(${JSON.stringify(c.equals)});`);
    else if ("contains" in c) out.push(`${i}expect(String(readPath(body, ${q(c.path)}))).toContain(${q(c.contains)});`);
    else if ("matches" in c) out.push(`${i}expect(String(readPath(body, ${q(c.path)}))).toMatch(new RegExp(${q(c.matches)}));`);
    else out.push(`${i}expect(readPath(body, ${q(c.path)})).toBeDefined();`);
  }
  for (const [name, path] of Object.entries(s.save || {})) {
    out.push(path === "status" ? `${i}${name} = res.status;` : `${i}${name} = readPath(body, ${q(path)});`);
  }
  out.push(`${indent}}`);
  return out;
}

module.exports = { apiStepLines, API_HELPERS, savedNames, toTemplate };
