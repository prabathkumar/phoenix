/**
 * OpenAPI 3 and Postman v2 -> api steps for the test-data layer
 * (docs/TEST_DATA.md). Each step with a JSON body is flagged generateBody and
 * negative, with the schema (OpenAPI) or the sample (Postman) to build from.
 * Path/collection variables become ${NAME}; a bearer-secured operation gets
 * an Authorization header from ${API_TOKEN}. Never makes a request.
 */
const { snake } = require("./testdata");

const HTTP = ["get", "post", "put", "patch", "delete"];
const up = (n) => snake(n).toUpperCase();

function deref(node, doc, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return node;
  if (Array.isArray(node)) return node.map((n) => deref(n, doc, depth + 1));
  if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
    const target = node.$ref.slice(2).split("/").reduce((o, k) => (o ? o[k.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined), doc);
    return deref(target, doc, depth + 1);
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(v, doc, depth + 1)]));
}

function stepsFromOpenApi(doc, { only } = {}) {
  if (!doc || typeof doc !== "object" || !doc.paths) throw new Error("That does not look like an OpenAPI file (no paths).");
  const steps = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of HTTP) {
      const op = item && item[method];
      if (!op || (only && !only.includes(`${method.toUpperCase()} ${path}`))) continue;
      const params = [...(item.parameters || []), ...(op.parameters || [])].map((p) => deref(p, doc));
      const url = path.replace(/\{([^}]+)\}/g, (_m, n) => "${" + up(n) + "}");
      const query = params.filter((p) => p.in === "query" && p.required).map((p) => `${encodeURIComponent(p.name)}=\${${up(p.name)}}`);
      const schema = deref(op.requestBody && op.requestBody.content && op.requestBody.content["application/json"] && op.requestBody.content["application/json"].schema, doc);
      const codes = Object.keys(op.responses || {}).filter((c) => /^2\d\d$/.test(c)).map(Number);
      const secured = (op.security || doc.security || []).length > 0;
      const step = {
        kind: "api", method: method.toUpperCase(),
        url: query.length ? `${url}?${query.join("&")}` : url,
        instruction: op.summary || `${method.toUpperCase()} ${path}`,
        ...(secured ? { headers: { Authorization: "Bearer ${API_TOKEN}" } } : {}),
        ...(schema ? { generateBody: true, negative: true, schema, body: {} } : {}),
        expect: { status: codes.length ? codes : [200, 201, 204] },
      };
      steps.push(step);
    }
  }
  if (!steps.length) throw new Error("The OpenAPI file has no operations to test.");
  return steps;
}

const fromVars = (text) => String(text).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, n) => "${" + up(n) + "}");
const BASE_VAR = /^\$\{(BASE_?URL|HOST|API_?URL|URL)\}/;

function stepsFromPostman(collection) {
  if (!collection || !Array.isArray(collection.item)) throw new Error("That does not look like a Postman collection (no items).");
  const steps = [];
  const walk = (items) => {
    for (const it of items) {
      if (Array.isArray(it.item)) { walk(it.item); continue; }
      const r = it.request;
      if (!r) continue;
      const raw = typeof r.url === "string" ? r.url : (r.url && r.url.raw) || "";
      if (!raw) continue;
      const url = fromVars(raw).replace(BASE_VAR, "") || "/";
      const headers = Object.fromEntries((r.header || []).filter((h) => !h.disabled).map((h) => [h.key, fromVars(h.value)]));
      let body;
      if (r.body && r.body.mode === "raw" && r.body.raw) {
        try { body = JSON.parse(fromVars(r.body.raw).replace(/"\$\{([A-Z0-9_]+)\}"/g, '"${$1}"')); } catch { body = undefined; }
      }
      steps.push({
        kind: "api", method: String(r.method || "GET").toUpperCase(), url: url.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `/${url}`,
        instruction: it.name || `${r.method} ${raw}`,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(body && typeof body === "object" ? { generateBody: true, negative: true, body } : body !== undefined ? { body } : {}),
        expect: { status: [200, 201, 202, 204] },
      });
    }
  };
  walk(collection.item);
  if (!steps.length) throw new Error("The collection has no requests to test.");
  return steps;
}

module.exports = { stepsFromOpenApi, stepsFromPostman, deref };
