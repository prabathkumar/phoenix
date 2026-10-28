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

const stepLines = (steps) => String(steps || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

/**
 * Shared by the plan endpoint and the English run start.
 * @returns {{plan:Object, error?:string}}
 */
function buildPlan(body, { env = process.env } = {}) {
  const mode = body.mode === "upload" ? "upload" : "generate";
  let provided = body.provided && typeof body.provided === "object" ? { ...body.provided } : {};
  let uploadNote = null;
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
    choices: body.choices && typeof body.choices === "object" ? body.choices : {},
    canCreate: body.canCreate === true,
    seed: typeof body.seed === "string" && body.seed ? body.seed : String(Date.now()),
  });
  if (uploadNote) plan.upload = td.checkUpload(uploadNote, names);
  return { plan };
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
  return json(200, { ...td.describePlan(plan), ...(plan.upload ? { upload: plan.upload } : {}) });
}

module.exports = { handlePlan, buildPlan, stepLines };
