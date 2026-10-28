/**
 * Where test data lives, per project.
 *
 *   <dir>/<project>.testdata.json   seed, choices, non-secret values (safe to commit)
 *   <dir>/<project>.secrets.json    saved logins/tokens, AES-256-GCM encrypted (never commit)
 *
 * <dir> is TESTOPS_TESTDATA_DIR, else ./test-data under the repo. Secrets need
 * TESTOPS_SECRETS_KEY (any long passphrase); without it nothing secret is
 * written, and the caller is told why in plain words.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const dirOf = () => process.env.TESTOPS_TESTDATA_DIR || path.join(__dirname, "..", "..", "test-data");
const safeProject = (p) => {
  const s = String(p || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s) || s.includes("..")) throw new Error("Project name may use letters, numbers, dot, dash and underscore only.");
  return s;
};
const fileOf = (project, kind) => path.join(dirOf(), `${safeProject(project)}.${kind}.json`);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw new Error(`Could not read ${path.basename(file)}: ${e.message}`); }
}
function writeJson(file, obj, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode });
  fs.renameSync(tmp, file);
}

// ---- the Test Data file (no secrets)
const saveFile = (project, file) => writeJson(fileOf(project, "testdata"), file, 0o644);
const loadFile = (project) => readJson(fileOf(project, "testdata"));

// ---- encrypted secrets
function keyFor(salt) {
  const pass = process.env.TESTOPS_SECRETS_KEY;
  if (!pass || pass.length < 8) throw new Error("Saving logins needs TESTOPS_SECRETS_KEY (8+ characters) in the server settings. Nothing secret was saved.");
  return crypto.scryptSync(pass, salt, 32);
}
function encrypt(map) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyFor(salt), iv);
  const data = Buffer.concat([c.update(JSON.stringify(map), "utf8"), c.final()]);
  return { v: 1, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}
function decrypt(blob) {
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", keyFor(Buffer.from(blob.salt, "base64")), Buffer.from(blob.iv, "base64"));
    d.setAuthTag(Buffer.from(blob.tag, "base64"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(blob.data, "base64")), d.final()]).toString("utf8"));
  } catch (e) {
    if (/TESTOPS_SECRETS_KEY/.test(e.message)) throw e;
    throw new Error("Saved logins could not be unlocked: TESTOPS_SECRETS_KEY is not the one they were saved with.");
  }
}

/** Saved secrets for a project as { NAME: value }. Empty when none saved; throws when saved but locked. */
function getSecrets(project) {
  const blob = readJson(fileOf(project, "secrets"));
  return blob ? decrypt(blob) : {};
}
function saveSecrets(project, values) {
  const merged = { ...getSecrets(project), ...values };
  for (const k of Object.keys(merged)) if (merged[k] === "" || merged[k] === undefined) delete merged[k];
  writeJson(fileOf(project, "secrets"), encrypt(merged), 0o600);
  return Object.keys(merged);
}
/** Names only; never values. Works without the key, so the page can show what is saved. */
function secretNames(project) {
  try { return Object.keys(getSecrets(project)); } catch { return null; } // null: saved but locked / no key
}
function hasSecretsFile(project) { return fs.existsSync(fileOf(project, "secrets")); }
function removeSecret(project, name) {
  const m = getSecrets(project); delete m[name];
  writeJson(fileOf(project, "secrets"), encrypt(m), 0o600);
}

module.exports = { saveFile, loadFile, saveSecrets, getSecrets, secretNames, hasSecretsFile, removeSecret, safeProject, dirOf };
