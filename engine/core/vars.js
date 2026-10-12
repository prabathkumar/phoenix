/**
 * ${NAME} placeholders for API steps and shared test data. Resolution order:
 * values saved earlier in the run / test data (`vars`), then the environment
 * (so secrets can stay out of committed files). Unlike a typed `text` field
 * (whole-string placeholder only, see engine/test-case-runner.js), API URLs,
 * headers and bodies need partial interpolation: `/orders/${ORDER_ID}`,
 * `Bearer ${API_TOKEN}`.
 */
const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function interpolate(text, ctx = {}) {
  const vars = ctx.vars || {};
  const env = ctx.env || process.env;
  return String(text).replace(PLACEHOLDER_RE, (_, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined) return String(vars[name]);
    if (typeof env[name] === "string" && env[name].length) return env[name];
    throw new Error(`\${${name}} is not set: add it as test data, save it from an earlier API step, or set the ${name} environment variable`);
  });
}

function interpolateDeep(value, ctx) {
  if (typeof value === "string") return interpolate(value, ctx);
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, ctx));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateDeep(v, ctx)]));
  }
  return value;
}

module.exports = { interpolate, interpolateDeep };
