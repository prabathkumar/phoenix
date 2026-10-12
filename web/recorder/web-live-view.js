/**
 * Web live view: a Chromium page mirrored to the tester over WebSocket.
 *
 * It speaks the SAME protocol as live-view/server.js (the mobile live view), so
 * the one recorder page in frontend/index.html drives both with the same
 * stage, side panel and flow. The web-only extras are additive.
 *
 * Client -> server
 *   {type:"tap", xRatio, yRatio}     click at a fraction of the mirrored page
 *   {type:"scroll", direction}       "up" | "down"
 *   {type:"type", value}             FULL value of the focused field (replaces)
 *   {type:"stop"}                    finish and generate
 *   web only: {type:"navigate", url} {type:"press", key} {type:"select", label}
 *             {type:"undo"} {type:"test-data", data} {type:"api", spec, record, force}
 *             {type:"ai-goal", goal}
 * Server -> client
 *   {type:"frame", screenshotBase64, mime}
 *   {type:"step-recorded", stepIndex, kind, instruction, resolvedElement:{text}}
 *   {type:"scroll-recorded", stepIndex, direction}
 *   {type:"text-entered", stepIndex}
 *   {type:"session-finished", stepCount}
 *   {type:"script-generated", scriptSource, testName, assertionCount, testCaseJson}
 *   {type:"busy"|"action-error"|"type-error", message}
 *   web only: {type:"page", url, title} {type:"select-options", instruction, options}
 *             {type:"ai-progress"|"ai-finished", ...}
 */
const { WebSocketServer } = require("ws");
const { WebRecorder } = require("./web-recorder");
const { toTestCase, toPlaywrightScript, inferWebFlowName } = require("./web-codegen");

const { createPlaywrightSurface } = require("../surface/playwright-surface");
const { runGoalLoop } = require("../../engine/core/goal-loop");

const FRAME_INTERVAL_MS = 250;
const VIEWPORT = { width: 1280, height: 800 };

async function launchBrowser(options = {}) {
  const { chromium } = require("playwright");
  return chromium.launch({
    headless: options.headless !== false,
    executablePath: options.executablePath || process.env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined,
  });
}

const normalizeUrl = (u) => (/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`);

function elementName(d) {
  if (!d) return "";
  return String(d.ariaLabel || d.labelText || d.text || d.placeholder || d.name || d.id || "").slice(0, 40);
}

function countAssertions(steps) {
  return steps.reduce((n, s) => n + ((s.expect && s.expect.appeared && s.expect.appeared.length) || 0) + (s.kind === "assert" ? 1 : 0), 0);
}

/**
 * "Ask AI": the AI layer works toward a goal in the live page; what it does is
 * appended to the recording as ordinary steps the tester can undo. Pass your own
 * `aiLoop` to startWebLiveView to replace it (tests do).
 */
async function defaultAiLoop({ goal, page, recorder, send, announce }) {
  if (!goal.trim()) throw new Error("Tell the AI what to do first.");
  const result = await runGoalLoop(createPlaywrightSurface(page), goal, {
    vision: true,
    onProgress: (p) => send({ type: "ai-progress", message: p.message, step: p.step }),
  });
  for (const { step } of result.steps) {
    recorder.steps.push({ ...step, resolvedBy: "ai" });
    announce(recorder.steps.length - 1, step, { name: step.instruction });
  }
  recorder._lastTap = null;
  send({ type: "ai-finished", success: result.success, message: result.reason, stepsAdded: result.steps.length });
}

/**
 * @param {{port:number, startUrl?:string, name?:string, browser?:Object, headless?:boolean, aiLoop?:Function}} opts
 * @returns {Promise<{wss:Object, port:number, recorder:Object, page:Object, close:Function}>}
 */
async function startWebLiveView({ port, startUrl, name, browser, headless, aiLoop = defaultAiLoop } = {}) {
  const ownsBrowser = !browser;
  const b = browser || (await launchBrowser({ headless }));
  const context = await b.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const recorder = new WebRecorder(page);
  const wss = new WebSocketServer({ port });
  await new Promise((resolve) => wss.once("listening", resolve));

  let busy = false;
  let stopped = false;
  let client = null;
  const send = (msg) => { try { if (client && client.readyState === 1) client.send(JSON.stringify(msg)); } catch { /* socket gone */ } };

  let frameInFlight = false;
  const frameTimer = setInterval(async () => {
    if (stopped || frameInFlight || !client) return;
    frameInFlight = true;
    try {
      const buf = await page.screenshot({ type: "jpeg", quality: 70 });
      if (!stopped) send({ type: "frame", screenshotBase64: buf.toString("base64"), mime: "image/jpeg" });
    } catch { /* page navigating */ } finally { frameInFlight = false; }
  }, FRAME_INTERVAL_MS);

  const announcePage = async () => send({ type: "page", url: page.url(), title: await page.title().catch(() => "") });
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) announcePage(); });

  async function shutdown() {
    if (stopped) return;
    stopped = true;
    clearInterval(frameTimer);
    try { await context.close(); } catch { /* ignore */ }
    if (ownsBrowser) { try { await b.close(); } catch { /* ignore */ } }
    try { wss.close(); } catch { /* ignore */ }
  }

  const announceStep = (index, step, extra = {}) =>
    send({
      type: "step-recorded",
      stepIndex: index,
      kind: step.kind,
      instruction: step.instruction,
      resolvedElement: { text: extra.name || "" },
      ...(step.option ? { option: step.option } : {}),
      ...(extra.fragile ? { fragile: true } : {}),
    });

  async function handle(message) {
    if (stopped) return; // nothing runs after Stop
    if (message.type === "stop") {
      busy = true;
      const steps = recorder.steps;
      const testName = name && name !== "recorded_web_flow" ? name : inferWebFlowName(steps);
      send({ type: "session-finished", stepCount: steps.length });
      send({
        type: "script-generated",
        scriptSource: toPlaywrightScript(steps, { name: testName }),
        testName,
        assertionCount: countAssertions(steps),
        testCaseJson: toTestCase(steps, { name: testName }),
      });
      await shutdown();
      return;
    }
    if (busy) { send({ type: "busy", message: "Still recording the previous step - wait a moment." }); return; }
    busy = true;
    try {
      if (message.type === "navigate") {
        const url = String(message.url || "").trim();
        if (!url) throw new Error("Enter a URL first.");
        const index = await recorder.navigate(normalizeUrl(url));
        announceStep(index, recorder.steps[index], { name: recorder.steps[index].url });
      } else if (message.type === "tap") {
        const result = await recorder.click(Number(message.xRatio), Number(message.yRatio));
        if (result.pendingSelect) {
          send({ type: "select-options", ...result.pendingSelect });
        } else {
          announceStep(result.index, result.step, { name: elementName(result.descriptor), fragile: result.fragile });
        }
      } else if (message.type === "type") {
        try {
          const { index } = await recorder.type(String(message.value ?? ""), message.param ? { param: String(message.param) } : {});
          send({ type: "text-entered", stepIndex: index });
        } catch (err) {
          if (err.code === "no-field") send({ type: "type-error", code: "no-field", message: err.message });
          else throw err;
        }
      } else if (message.type === "select") {
        const { index, step } = await recorder.select(String(message.label ?? ""));
        announceStep(index, step, { name: step.option });
      } else if (message.type === "press") {
        const { index, step } = await recorder.press(String(message.key || "Enter"));
        announceStep(index, step, { name: step.key });
      } else if (message.type === "scroll") {
        const { index } = await recorder.scroll(message.direction === "up" ? "up" : "down");
        send({ type: "scroll-recorded", stepIndex: index, direction: message.direction === "up" ? "up" : "down" });
      } else if (message.type === "undo") {
        const removed = recorder.undo();
        send({ type: "step-undone", removed, stepCount: recorder.steps.length });
      } else if (message.type === "test-data") {
        recorder.setTestData(message.data);
      } else if (message.type === "api") {
        const out = await recorder.api(message.spec || {}, { record: !!message.record, force: !!message.force });
        send({
          type: "api-result",
          ok: out.result.ok,
          reason: out.result.reason,
          status: out.result.status,
          durationMs: out.result.durationMs,
          response: out.result.response,
          saved: out.result.saved,
          recorded: out.recorded,
          stepIndex: out.index,
        });
      } else if (message.type === "ai-goal") {
        if (typeof aiLoop !== "function") throw new Error("The AI goal loop is not enabled on this server.");
        send({ type: "ai-progress", message: "starting…" });
        await aiLoop({ goal: String(message.goal || ""), page, recorder, send, announce: announceStep });
      }
    } catch (err) {
      send({ type: "action-error", code: err.code, message: err.message });
    } finally {
      busy = false;
    }
  }

  wss.on("connection", (socket) => {
    client = socket;
    socket.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      handle(msg);
    });
    socket.on("close", () => { if (client === socket) client = null; });
    announcePage();
  });

  if (startUrl) {
    try { await recorder.navigate(normalizeUrl(startUrl)); } catch { /* surfaced as a blank page */ }
  }

  return { wss, port, recorder, page, close: shutdown };
}

module.exports = { startWebLiveView, VIEWPORT };
