/**
 * FrothTestOps unified prompt registry - Node loader (phoenix_engine).
 *
 *   const { getPrompt } = require("../../prompts/registry");
 *   const { text, id } = getPrompt("element_resolver", "mobile");
 *   console.error(`[llm] prompt_id=${id}`);
 *
 * Platforms: "web", "mobile", or "shared" (falls back to "shared").
 * Hot-reloads when prompts.yaml changes. Override location with PROMPTS_FILE.
 * Requires: npm install js-yaml
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const yaml = require("js-yaml");

const FILE = process.env.PROMPTS_FILE || path.join(__dirname, "prompts.yaml");
let cache = { mtime: 0, data: null };

function validate(data) {
  const blocks = data.blocks || {};
  for (const [name, variants] of Object.entries(data.prompts || {})) {
    for (const [platform, list] of Object.entries(variants)) {
      const missing = list.filter((b) => !(b in blocks));
      if (missing.length) throw new Error(`prompt '${name}:${platform}' references unknown blocks: ${missing}`);
    }
  }
}

function load() {
  const mtime = fs.statSync(FILE).mtimeMs;
  if (mtime !== cache.mtime) {
    const data = yaml.load(fs.readFileSync(FILE, "utf8"));
    validate(data);
    cache = { mtime, data };
  }
  return cache.data;
}

/** Returns { text, id }. Log id with every LLM call. */
function getPrompt(name, platform = "shared", vars = {}) {
  const reg = load();
  const variants = reg.prompts[name];
  if (!variants) throw new Error(`unknown prompt '${name}'`);
  const used = variants[platform] ? platform : "shared";
  if (!variants[used]) throw new Error(`prompt '${name}' has no '${platform}' or 'shared' variant`);
  let text = variants[used].map((b) => reg.blocks[b].trim()).join("\n\n");
  const digest = crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
  const id = `${name}:${used}:${reg.version}:${digest}`;
  for (const [k, v] of Object.entries(vars)) text = text.split(`{{${k}}}`).join(String(v));
  return { text, id };
}

function listPrompts() {
  return Object.fromEntries(Object.entries(load().prompts).map(([n, v]) => [n, Object.keys(v)]));
}

module.exports = { getPrompt, listPrompts };
