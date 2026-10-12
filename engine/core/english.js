/**
 * Plain-English test cases: one line = one step ("Open the login page",
 * "Enter ${LOGIN_PHONE} as the phone number"). Named test data is written as
 * ${NAME} and filled in at run time, so the English stays readable and the
 * values live in the test-data table on the page.
 *
 * Secrets: a value whose NAME looks secret (password, pin, otp, token ...) is
 * never printed back - progress, failure reasons and logs show ${NAME} instead.
 */
const SECRET_NAME_RE = /(pass(word)?|pwd|secret|token|pin|otp|tac|key|cvv)/i;
const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Lines -> steps. Blank lines and "# comment" lines are ignored; leading "1." / "-" bullets are stripped. */
function parseSteps(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^(\d+[.)]|[-*•])\s+/, "").trim())
    .filter((l) => l && !l.startsWith("#"));
}

const isSecretName = (name) => SECRET_NAME_RE.test(String(name));

/** Names used as ${NAME} in the steps, in order, without repeats. */
function placeholdersIn(steps) {
  const seen = [];
  for (const s of steps) for (const m of String(s).matchAll(PLACEHOLDER_RE)) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen;
}

/** Fills ${NAME}. Returns {text} or {missing:[names]} - a missing value is an error, never an empty string. */
function applyTestData(step, data = {}) {
  const missing = [];
  const text = String(step).replace(PLACEHOLDER_RE, (_m, name) => {
    if (data[name] === undefined || data[name] === null || data[name] === "") { missing.push(name); return _m; }
    return String(data[name]);
  });
  return missing.length ? { missing } : { text };
}

/** Replaces every secret value that appears in `text` with its ${NAME}. */
function redact(text, data = {}) {
  let out = String(text ?? "");
  const secrets = Object.entries(data)
    .filter(([name, v]) => isSecretName(name) && v !== undefined && v !== null && String(v) !== "")
    .sort((a, b) => String(b[1]).length - String(a[1]).length); // longest first, so a prefix can't leave a tail
  for (const [name, v] of secrets) out = out.split(String(v)).join("${" + name + "}");
  return out;
}

/** The test data as the UI may show it: secret values masked. */
function maskedData(data = {}) {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, isSecretName(k) ? "••••••" : String(v)]));
}

module.exports = { parseSteps, placeholdersIn, applyTestData, redact, maskedData, isSecretName };
