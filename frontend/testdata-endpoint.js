/**
 * Test-data layer over HTTP (engine/core/testdata.js).
 *
 *   POST /api/test-data/plan
 *     JSON {steps, mode?:"generate"|"upload", upload?:"<csv or json text>",
 *           provided?:{NAME:value}, choices?:{NAME:"saved"|"type"|"create"|"skip"},
 *           hints?:{NAME:{...}}, canCreate?, seed?}
 *     -> {seed, ready, needsYou:[NAME], fields:[{name, kind, source, ...}]}
 *
 * This is what the page shows before a run: "Generate test data", with the
 * fields the layer made up and the ones only the tester can supply. Secret
 * values never come back (describePlan masks them).
 */
const td = require("../engine/core/testdata");
const store = require("../engine/core/testdata-store");

const stepLines = (steps) => Array.isArray(steps) ? steps : String(steps || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

/**
 * Shared by the plan endpoint and the English run start.
 * @returns {{plan:Object, error?:string}}
 */
function buildPlan(body, { env = process.env } = {}) {
  const mode = body.mode === "upload" ? "upload" : "generate";
  let provided = body.provided && typeof body.provided === "object" ? { ...body.provided } : {};
  let uploadNote = null;
  let choices = body.choices && typeof body.choices === "object" ? body.choices : {};
  let seedFromFile = null;
  let savedNames = [];
  if (body.project) {
    // Saved per-project data: the Test Data file (seed, choices, plain values) and saved logins.
    try {
      const file = store.loadFile(body.project);
      const secrets = store.hasSecretsFile(body.project) ? store.getSecrets(body.project) : {};
      if (file) { seedFromFile = file.seed; choices = { ...(file.choices || {}), ...choices }; provided = { ...file.values, ...provided }; }
      for (const [k, v] of Object.entries(secrets)) {
        if (choices[k] === "skip" || provided[k] !== undefined) continue;
        provided[k] = v; savedNames.push(k);
      }
    } catch (e) { return { error: e.message }; }
  }
  if (mode === "upload") {
    let uploaded;
    try { uploaded = td.parseUploaded(body.upload); } catch (e) { return { error: e.message }; }
    provided = { ...uploaded, ...provided };
    uploadNote = uploaded;
  }
  const names = td.requiredNames(stepLines(body.steps), { env });
  const plan = td.planTestData({
    names,
    hints: body.hints && typeof body.hints === "object" ? body.hints : {},
    provided,
    mode,
    fill: body.fill !== false,
    choices,
    canCreate: body.canCreate === true,
    seed: typeof body.seed === "string" && body.seed ? body.seed : seedFromFile || String(Date.now()),
  });
  plan.savedNames = savedNames.filter((n) => plan.fields.some((f) => f.name === n));
  if (uploadNote) plan.upload = td.checkUpload(uploadNote, names);
  return { plan };
}

/** Steps from a list, an OpenAPI file or a Postman collection. Throws a plain Error. */
function resolveApiSteps(body) {
  const imp = require("../engine/core/api-import");
  return body.openapi ? imp.stepsFromOpenApi(body.openapi, { only: body.only }) : body.postman ? imp.stepsFromPostman(body.postman) : body.steps;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

async function handlePlan(req, res) {
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
  let body;
  try { body = await readJson(req); } catch (e) { return json(400, { error: `Bad request: ${e.message}` }); }
  if (!String(body.steps || "").trim()) return json(400, { error: "Write at least one step in English first." });
  const { plan, error } = buildPlan(body);
  if (error) return json(400, { error });
  return json(200, { ...td.describePlan(plan), saved: plan.savedNames, ...(plan.upload ? { upload: plan.upload } : {}) });
}

/**
 * POST /api/test-data/api-plan {steps:[api steps], seed?, provided?, project?, negative?}
 * -> {seed, ready, needsYou, fields, steps (bodies filled; secrets stay ${NAME}), negativeCases:[{name}]}
 */
async function handleApiPlan(req, res) {
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
  let body;
  try { body = await readJson(req); } catch (e) { return json(400, { error: `Bad request: ${e.message}` }); }
  let steps;
  try { steps = resolveApiSteps(body); } catch (e) { return json(400, { error: e.message }); }
  if (!Array.isArray(steps) || !steps.length) return json(400, { error: "Send the test case's steps as a list, or an OpenAPI file or Postman collection." });
  body = { ...body, steps };
  const { plan, error } = buildPlan(body);
  if (error) return json(400, { error });
  const prepared = td.prepareApiSteps(body.steps, { seed: plan.seed });
  // Names inside generated bodies are found by planning again on the prepared steps.
  const { plan: full } = buildPlan({ ...body, steps: prepared.steps, seed: plan.seed });
  const cases = body.negative ? td.negativeApiCases(body.steps, { seed: plan.seed }) : [];
  return json(200, { ...td.describePlan(full), saved: full.savedNames, steps: prepared.steps, negativeCases: cases.map((c) => ({ name: c.name })) });
}

/**
 * POST /api/api-cases/run {steps | openapi | postman, only?, baseUrl, testData?, negative?, seed?, project?}
 * Runs the API test case (and its generated negative cases) against baseUrl, from this server.
 * Refuses to start, naming the fields, while a must-exist value (a token, a login) is missing.
 */
async function handleApiRun(req, res) {
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
  let body;
  try { body = await readJson(req); } catch (e) { return json(400, { error: `Bad request: ${e.message}` }); }
  let steps;
  try { steps = resolveApiSteps(body); } catch (e) { return json(400, { error: e.message }); }
  if (!Array.isArray(steps) || !steps.length) return json(400, { error: "Give the steps as a list, or an OpenAPI file or Postman collection." });
  if (steps.some((s) => !s || typeof s !== "object")) return json(400, { error: "Every step must be an object." });
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) return json(400, { error: "The API address must start with http:// or https://." });
  if (!baseUrl && steps.some((s) => s.kind === "api" && typeof s.url === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(s.url) && !/^\$\{/.test(s.url))) return json(400, { error: "An API address is required because the steps use relative paths." });
  const seedIn = typeof body.seed === "string" && body.seed ? body.seed : undefined;
  const first = buildPlan({ steps, provided: body.testData, project: body.project, seed: seedIn, choices: body.choices });
  if (first.error) return json(400, { error: first.error });
  const prepared = td.prepareApiSteps(steps, { seed: first.plan.seed });
  const { plan, error } = buildPlan({ steps: prepared.steps, provided: body.testData, project: body.project, seed: first.plan.seed, choices: body.choices });
  if (error) return json(400, { error });
  const missing = plan.needsYou;
  if (missing.length) return json(400, { error: `Before this can run I need: ${missing.join(", ")}. These must already exist in your system, so I cannot make them up. Type them, save them, or choose skip.`, needsYou: missing });
  const { runApiCases } = require("../engine/core/api-cases");
  const { redact } = require("../engine/core/english");
  const r = await runApiCases({ steps, testData: plan.values, baseUrl: baseUrl || undefined, seed: plan.seed, negative: body.negative === true });
  const clean = (x) => ({ ...x, detail: redact(x.detail, plan.values) });
  return json(200, { ...r, main: clean(r.main), negatives: r.negatives.map(clean), stepCount: steps.length });
}

/** POST /api/test-data/save {project, steps, provided, choices, seed, saveLogins?} */
async function handleSave(req, res) {
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
  let body;
  try { body = await readJson(req); } catch (e) { return json(400, { error: `Bad request: ${e.message}` }); }
  try { store.safeProject(body.project); } catch (e) { return json(400, { error: e.message }); }
  if (body.openapi || body.postman || Array.isArray(body.steps)) {
    // API case: plan over the bodies the layer generates, so their ${NAME}s are covered.
    try { const steps = resolveApiSteps(body); body = { ...body, steps: td.prepareApiSteps(steps, { seed: body.seed || "save" }).steps }; } catch (e) { return json(400, { error: e.message }); }
  }
  if (!String(body.steps || "").trim()) return json(400, { error: "Write at least one step first." });
  // Plan from what was typed only: do not re-save what already came from the store.
  const { plan, error } = buildPlan({ ...body, project: undefined });
  if (error) return json(400, { error });
  const out = { file: false, logins: [], note: "" };
  try { store.saveFile(body.project, td.toFile(plan, { choices: plan.fields.reduce((m, f) => (f.source === "negative-only" ? { ...m, [f.name]: "skip" } : m), {}) })); out.file = true; }
  catch (e) { return json(500, { error: e.message }); }
  if (body.saveLogins) {
    const secrets = Object.fromEntries(plan.fields.filter((f) => f.secret && f.source === "provided").map((f) => [f.name, plan.values[f.name]]));
    if (Object.keys(secrets).length) {
      try { out.logins = store.saveSecrets(body.project, secrets); } catch (e) { out.note = e.message; }
    }
  }
  return json(200, out);
}

/** GET /api/test-data/saved?project=NAME -> what is saved (names only, never values). */
function handleSaved(req, res) {
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
  let project;
  try { project = store.safeProject(new URL(req.url, "http://x").searchParams.get("project")); } catch (e) { return json(400, { error: e.message }); }
  try {
    const file = store.loadFile(project);
    return json(200, { project, file: !!file, seed: file ? file.seed : null, names: file ? file.names : [], logins: store.hasSecretsFile(project) ? store.secretNames(project) : [], locked: store.hasSecretsFile(project) && store.secretNames(project) === null });
  } catch (e) { return json(500, { error: e.message }); }
}

module.exports = { handlePlan, handleApiPlan, handleApiRun, handleSave, handleSaved, buildPlan, stepLines };
