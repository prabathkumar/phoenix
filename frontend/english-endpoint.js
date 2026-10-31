/**
 * "Run from English": a test case written in plain English, with the URL (web) or
 * app (mobile) and named test data, run by the AI layers on the live page/app.
 *
 *   POST /api/english-runs
 *     web    JSON  {platform:"web", url, steps, testData}
 *     mobile multipart: platform=android|ios, steps, testData (JSON text),
 *            and either file "app" (.apk/.ipa) or field appUrl ("bs://...")
 *     -> {runId}
 *   GET  /api/english-runs/:id/events     Server-Sent Events, replayed from the start
 *
 * Events: run-started, step-started, step-progress, step-finished (with a
 * screenshot), run-finished. Secret test-data values are never sent (see
 * engine/core/english.js). Web and mobile are independent runs; one mobile run
 * at a time (a BrowserStack session costs minutes).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Busboy = require("busboy");

const { runEnglish, webRunner, mobileRunner } = require("../engine/english-run");
const { redact } = require("../engine/core/english");
const { buildPlan } = require("./testdata-endpoint");
const { launchWebBrowser, normalizeRunOn } = require("../web/browser-provider");

const UPLOAD_DIR = path.join(__dirname, "uploads");
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const EXT_PLATFORM = { ".ipa": "ios", ".apk": "android" };
const runs = new Map(); // id -> {events:[], listeners:Set, done:boolean}
let mobileActive = false;

const normalizeUrl = (u) => (/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`);

/** Plain-language version of the errors a first-time mobile run actually hits. */
function friendlyStartError(message) {
  const m = String(message || "");
  if (/:4723|browser driver is running|ECONNREFUSED/i.test(m)) {
    return "Mobile has no device service to talk to. Start the server with your BrowserStack settings: docker run --rm --env-file .env -p 8091:8091 -p 8092-8099:8092-8099 --shm-size=1g testops-mobile:latest node frontend/server.js";
  }
  if (/executable doesn't exist|browserType\.launch/i.test(m)) {
    return "The browser is not installed here. Run: cd web && npx playwright install chromium (the Docker image already has it).";
  }
  return m;
}

/** Playwright lives in web/node_modules (that is where the image installs it); fall back to any other install. */
function loadPlaywright() {
  try { return require(require.resolve("playwright", { paths: [path.join(__dirname, "..", "web")] })); }
  catch { return require("playwright"); }
}

/** Chromium on this server, or a BrowserStack browser, per run. Returns the Playwright browser. */
async function defaultLaunchBrowser({ runOn, target } = {}) {
  const { chromium } = loadPlaywright();
  return (await launchWebBrowser({ runOn, target, chromium })).browser;
}

async function defaultStartMobile({ platform, capabilityOverrides, provider, device, osVersion }) {
  const { startSession } = require(platform === "ios" ? "../engine/ios-session" : "../engine/session");
  return startSession(capabilityOverrides, { provider, device, osVersion });
}

function createEnglishEndpoint(deps = {}) {
  const launchBrowser = deps.launchBrowser || defaultLaunchBrowser;
  const startMobile = deps.startMobile || defaultStartMobile;
  const resolveApp = deps.resolveApp || ((a) => require("./upload-session").resolveAppCapability(a));
  const makeWebRunner = deps.webRunner || webRunner;
  const makeMobileRunner = deps.mobileRunner || mobileRunner;

  const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };

  function newRun() {
    const id = crypto.randomUUID();
    const run = { events: [], listeners: new Set(), done: false };
    runs.set(id, run);
    const emit = (e) => {
      run.events.push(e);
      for (const l of run.listeners) { try { l(e); } catch { /* listener gone */ } }
      if (e.type === "run-finished") run.done = true;
    };
    return { id, run, emit };
  }

  async function execute({ emit, platform, steps, testData, url, appCapability, appPath, target: passedTarget, runOn, mobileChoice = {}, harPath }) {
    const target = require("../engine/core/run-target");
    emit({ type: "run-started", platform, where: platform === "web" ? { label: runOn === "browserstack" ? "BrowserStack · Playwright" : "Local · Playwright", ...target.webTarget({ wsEndpoint: runOn === "browserstack" ? "wss://cdp.browserstack.com/playwright" : undefined }) } : { label: "Starting…" } });
    let browser; let driver; let context;
    try {
      let runner;
      if (platform === "web") {
        browser = await launchBrowser({ runOn, target: passedTarget });
        context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...(harPath ? { recordHar: { path: harPath, mode: "minimal" } } : {}) });
        const page = await context.newPage();
        await page.goto(normalizeUrl(url), { waitUntil: "load", timeout: 45000 });
        runner = makeWebRunner(page);
        try { const t = target.mergeTarget(passedTarget, target.targetFromBrowser(browser, runOn === "browserstack" ? { headless: undefined, wsEndpoint: "wss://cdp.browserstack.com/playwright" } : { headless: true })); emit({ type: "run-where", where: { ...t, label: `${target.targetLabel(t)} · Playwright` } }); } catch { /* label is best-effort */ }
      } else {
        const capabilityOverrides = appCapability || (await resolveApp({ savedPath: appPath, platform, provider: mobileChoice.provider }));
        driver = await startMobile({ platform, capabilityOverrides, ...mobileChoice });
        runner = makeMobileRunner(driver, platform);
        try { const t = target.mergeTarget(passedTarget, target.targetFromDriver(driver, platform, process.env, mobileChoice.provider)); emit({ type: "run-where", where: { ...t, label: `${target.targetLabel(t)} · Appium` } }); } catch { /* label is best-effort */ }
      }
      await runEnglish({ steps, testData, runner, onEvent: emit });
    } catch (err) {
      emit({ type: "run-finished", status: "failed", reason: redact(friendlyStartError(err.message), testData), steps: [], passed: 0, failed: 0 });
    } finally {
      if (context) { try { await context.close(); } catch { /* ignore */ } } // writes the HAR
      if (browser) { try { await browser.close(); } catch { /* ignore */ } }
      if (driver) { try { await driver.deleteSession(); } catch { /* ignore */ } }
      if (platform !== "web") mobileActive = false;
    }
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
      req.on("error", reject);
    });
  }

  function readMultipart(req) {
    return new Promise((resolve, reject) => {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      let bb;
      try { bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_UPLOAD_BYTES } }); } catch (e) { reject(e); return; }
      const fields = {}; let filePath = null; let fileName = null; let tooBig = false; let write = Promise.resolve();
      bb.on("field", (n, v) => { fields[n] = v; });
      bb.on("file", (_n, stream, info) => {
        fileName = info.filename;
        filePath = path.join(UPLOAD_DIR, `${crypto.randomUUID()}${path.extname(fileName || "").toLowerCase()}`);
        stream.on("limit", () => { tooBig = true; });
        write = new Promise((ok, bad) => { const w = fs.createWriteStream(filePath); stream.pipe(w); w.on("finish", ok); w.on("error", bad); });
      });
      bb.on("error", reject);
      bb.on("finish", () => write.then(() => resolve({ fields, filePath, fileName, tooBig }), reject));
      req.pipe(bb);
    });
  }

  const discard = (upload) => { if (upload && upload.filePath) fs.unlink(upload.filePath, () => {}); };

  async function handleStart(req, res) {
    const isMultipart = /multipart\/form-data/i.test(req.headers["content-type"] || "");
    let body;
    let upload = null;
    try {
      if (isMultipart) { upload = await readMultipart(req); body = upload.fields; } else body = await readJson(req);
    } catch (err) { return json(res, 400, { error: `Bad request: ${err.message}` }); }

    const parseData = (d) => { if (!d) return {}; if (typeof d === "object") return d; try { return JSON.parse(d); } catch { return null; } };
    const testData = parseData(body.testData);
    if (testData === null) { discard(upload); return json(res, 400, { error: "testData must be a JSON object." }); }
    const steps = String(body.steps || "");
    if (!steps.trim()) { discard(upload); return json(res, 400, { error: "Write at least one step in English first." }); }

    // Test-data layer (optional): with dataMode set, the layer fills what it can
    // and the run refuses to start while a must-exist field (a login, a token)
    // has no value - the tester is told which ones, before anything runs.
    let runData = testData;
    if (body.dataMode === "generate" || body.dataMode === "upload") {
      const parseObj = (d) => { const v = parseData(d); return v && typeof v === "object" ? v : {}; };
      const { plan, error } = buildPlan({
        steps, mode: body.dataMode, upload: body.dataUpload, fill: body.dataFill !== "false" && body.dataFill !== false,
        provided: testData, choices: parseObj(body.dataChoices), hints: parseObj(body.dataHints),
        project: body.dataProject || undefined, canCreate: body.dataCanCreate === true || body.dataCanCreate === "true", seed: body.dataSeed,
      });
      if (error) { discard(upload); return json(res, 400, { error }); }
      if (!plan.ready) {
        discard(upload);
        return json(res, 400, { error: `Before this can run I need: ${plan.needsYou.join(", ")}. These must already exist in your system, so I cannot make them up. Type them, use a saved value, or choose skip.`, needsYou: plan.needsYou });
      }
      runData = plan.values;
    }

    const platform = body.platform;
    if (platform === "web") {
      if (!body.url || typeof body.url !== "string") return json(res, 400, { error: "A URL is required for a web test." });
      const { id, emit } = newRun();
      execute({ emit, platform, steps, testData: runData, url: body.url, runOn: normalizeRunOn(body.runOn), target: require("../engine/core/run-target").normalizeTarget(body.target) });
      return json(res, 200, { runId: id });
    }

    // mobile
    const ext = upload && upload.fileName ? path.extname(upload.fileName).toLowerCase() : "";
    if (!(upload && upload.filePath) && !body.appUrl) { discard(upload); return json(res, 400, { error: "Upload the app (.apk/.ipa) or give an already-uploaded bs:// URL." }); }
    const mobilePlatform = body.platform === "ios" || body.platform === "android" ? body.platform : EXT_PLATFORM[ext];
    if (!mobilePlatform) { discard(upload); return json(res, 400, { error: "Choose Android or iOS - an app URL does not say which it is." }); }
    if (upload && upload.tooBig) { discard(upload); return json(res, 413, { error: "The app file is larger than 500MB." }); }
    if (mobileActive) { discard(upload); return json(res, 409, { error: "A mobile run is already in progress. Wait for it to finish." }); }
    mobileActive = true;
    const { id, emit } = newRun();
    execute({
      emit, platform: mobilePlatform, steps, testData: runData,
      appCapability: body.appUrl && !(upload && upload.filePath) ? { "appium:app": String(body.appUrl) } : undefined,
      appPath: upload && upload.filePath,
      target: require("../engine/core/run-target").normalizeTarget(body.target),
      mobileChoice: { provider: require("../engine/core/run-target").chooseProvider(body.runOn), ...(body.device ? { device: String(body.device).slice(0, 100) } : {}), ...(body.osVersion ? { osVersion: String(body.osVersion).slice(0, 30) } : {}) },
    });
    return json(res, 200, { runId: id });
  }

  function handleEvents(req, res, id) {
    const run = runs.get(id);
    if (!run) return json(res, 404, { error: "Unknown run." });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const write = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    run.events.forEach(write);
    if (run.done) return res.end();
    const listener = (e) => { write(e); if (e.type === "run-finished") { run.listeners.delete(listener); res.end(); } };
    run.listeners.add(listener);
    req.on("close", () => run.listeners.delete(listener));
  }

  /**
   * Run English steps to the end without HTTP; used by the pipeline.
   * @returns {Promise<{status, passed, failed, steps, where}>} where = the "Running on" label (no credentials).
   */
  async function runAndWait({ platform, steps, testData = {}, url, runOn, device, osVersion, appUrl, appPath, target, harPath }) {
    const t = require("../engine/core/run-target");
    const { run, emit } = newRun();
    let where = null;
    run.listeners.add((e) => { if (e.type === "run-where" || e.type === "run-started") where = (e.where && e.where.label) || where; });
    const done = new Promise((ok) => run.listeners.add((e) => { if (e.type === "run-finished") ok(e); }));
    const mobile = platform !== "web";
    if (mobile) { if (mobileActive) throw new Error("A mobile run is already in progress."); mobileActive = true; }
    const finished = execute({ emit, platform, steps: String(steps), testData, url, runOn: normalizeRunOn(runOn), target: t.normalizeTarget(target), harPath,
      ...(mobile ? { appCapability: appUrl ? { "appium:app": String(appUrl) } : undefined, appPath, mobileChoice: { provider: t.chooseProvider(runOn), ...(device ? { device: String(device).slice(0, 100) } : {}), ...(osVersion ? { osVersion: String(osVersion).slice(0, 20) } : {}) } } : {}) });
    await finished; // the browser is closed (and the HAR written) before we return
    const fin = await done;
    return { status: fin.status, passed: fin.passed, failed: fin.failed, steps: (fin.steps || []).map((r) => ({ index: r.index, text: r.text, status: r.status, reason: r.reason || r.error })), where, reason: fin.reason };
  }

  return { handleStart, handleEvents, runAndWait };
}

const defaults = createEnglishEndpoint();
module.exports = { ...defaults, createEnglishEndpoint, friendlyStartError, loadPlaywright, _runs: runs };
