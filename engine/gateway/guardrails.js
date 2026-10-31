/**
 * Guardrails: checks on what goes to a model (input) and what comes back (output).
 * Rule: {id, type, applies: "input"|"output"|"both", action: "block"|"redact"|"warn", params?}
 * Types: secrets (keys, tokens, passwords, plus known secret values) | pii (email, phone, card) |
 *        injection (instructions hidden in input) | json (output must be JSON with required keys) |
 *        length (max characters) | words (banned phrases)
 * Heuristics, not guarantees: they catch the common cases and say what they did. Block wins over redact over warn.
 */
const PATTERNS = {
  secrets: [/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}\b/g, /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, /\bAKIA[0-9A-Z]{16}\b/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{4,}/gi],
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  phone: /(?<![\d.])\+?\d[\d\s().-]{8,14}\d(?![\d.])/g,
  card: /\b(?:\d[ -]?){13,19}\b/g,
};
const INJECTION = [/ignore (?:all |any |the )?(?:previous|prior|above) (?:instructions|prompts?)/i, /disregard (?:the |your )?(?:system|previous) (?:prompt|instructions)/i, /you are now (?:in )?(?:dan|developer mode)/i, /reveal (?:your|the) (?:system )?prompt/i, /<\/?(?:system|assistant)>/i];
const luhn = (d) => { let s = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } s += n; alt = !alt; } return s % 10 === 0; };

function check(rule, text, { secrets = [] } = {}) {
  const t = String(text || ""); const found = [];
  let out = t;
  const sub = (re, label, ok = () => true) => { out = out.replace(re, (m) => { if (!ok(m)) return m; found.push(label); return `[${label}]`; }); };
  switch (rule.type) {
    case "secrets":
      PATTERNS.secrets.forEach((re) => sub(re, "SECRET"));
      for (const v of secrets) if (v && String(v).length >= 4 && out.includes(String(v))) { out = out.split(String(v)).join("[SECRET]"); found.push("SECRET"); }
      break;
    case "pii":
      sub(PATTERNS.email, "EMAIL"); sub(PATTERNS.card, "CARD", (m) => { const d = m.replace(/\D/g, ""); return d.length >= 13 && luhn(d); }); sub(PATTERNS.phone, "PHONE", (m) => m.replace(/\D/g, "").length >= 10);
      break;
    case "injection": INJECTION.forEach((re) => { if (re.test(t)) found.push("INJECTION"); }); break;
    case "json": {
      const need = (rule.params && rule.params.keys) || [];
      try { const j = JSON.parse(t.replace(/^```(?:json)?\s*|\s*```$/g, "")); need.filter((k) => !(k in (j || {}))).forEach((k) => found.push(`missing "${k}"`)); } catch { found.push("not JSON"); }
      break;
    }
    case "length": if (t.length > ((rule.params && rule.params.max) || 20000)) found.push("too long"); break;
    case "words": ((rule.params && rule.params.list) || []).forEach((w) => { if (w && t.toLowerCase().includes(String(w).toLowerCase())) found.push(`phrase "${w}"`); }); break;
    default: throw new Error(`unknown guardrail type "${rule.type}"`);
  }
  return { found, text: rule.action === "redact" ? out : t };
}

/**
 * @returns {{text, blocked:boolean, results:[{id,type,action,hit,found}]}} -- text is redacted when a redact rule fired.
 */
function run(rules, side, text, ctx = {}) {
  let cur = String(text || ""), blocked = false; const results = [];
  for (const rule of rules || []) {
    if (rule.enabled === false || !(rule.applies === "both" || rule.applies === side || !rule.applies)) continue;
    const r = check(rule, cur, ctx);
    const hit = r.found.length > 0;
    if (hit && rule.action === "block") blocked = true;
    if (hit && rule.action === "redact") cur = r.text;
    results.push({ id: rule.id, type: rule.type, action: rule.action, hit, found: [...new Set(r.found)] });
  }
  return { text: cur, blocked, results };
}

const DEFAULT_RULES = [
  { id: "no-secrets", type: "secrets", applies: "both", action: "redact" },
  { id: "no-pii", type: "pii", applies: "input", action: "redact" },
  { id: "no-injection", type: "injection", applies: "input", action: "warn" },
  { id: "max-length", type: "length", applies: "input", action: "block", params: { max: 60000 } },
];
module.exports = { run, check, DEFAULT_RULES };
