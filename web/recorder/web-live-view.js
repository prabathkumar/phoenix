/**
 * Web live view: a Chromium page mirrored to the tester over WebSocket.
 * The tester clicks / types / scrolls in the mirror; every action is performed
 * on the real page AND recorded as a step (web-recorder.js).
 *
 * Protocol (client -> server): {type:"navigate",url} {type:"click",xRatio,yRatio}
 *   {type:"type",text} {type:"press",key} {type:"scroll",direction} {type:"stop"}
 * Server -> client: {type:"ready",viewport} {type:"frame",screenshotBase64}
 *   {type:"page",url,title} {type:"step",index,step} {type:"error",message}
 *   {type:"busy"} {type:"stopped",steps,script,testCase}
 */
const { WebSocketServer } = require("ws");
const { WebRecorder } = require("./web-recorder");
const { toTestCase, toPlaywrightScript } = require("./web-codegen");

const FRAME_INTERVAL_MS = 250;
const VIEWPORT = { width: 1280, height: 800 };

async function launchBrowser(options = {}) {
  const { chromium } = require("playwright");
  return chromium.launch({
    headless: options.headless !== false,
    executablePath: options.executablePath || process.env.TESTOPS_MOBILE_WEB_CHROMIUM_PATH || undefined,
  });
}

/**
 * @param {{port:number, startUrl?:string, name?:string, browser?:Object, headless?:boolean}} opts
 * @returns {Promise<{wss:Object, close:Function, port:number}>}
 */
async function startWebLiveView({ port, startUrl, name = "recorded_web_flow", browser, headless } = {}) {
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
      if (!stopped) send({ type: "frame", screenshotBase64: buf.toString("base64") });
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

  async function handle(message) {
    if (message.type === "stop") {
      const steps = recorder.steps;
      send({ type: "stopped", steps, script: toPlaywrightScript(steps, { name }), testCase: toTestCase(steps, { name }) });
      await shutdown();
      return;
    }
    if (busy) { send({ type: "busy" }); return; }
    busy = true;
    try {
      if (message.type === "navigate") {
        let url = String(message.url || "").trim();
        if (!url) throw new Error("Enter a URL first.");
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
        const index = await recorder.navigate(url);
        send({ type: "step", index, step: recorder.steps[index] });
      } else if (message.type === "click") {
        const { index, step } = await recorder.click(Number(message.xRatio), Number(message.yRatio));
        send({ type: "step", index, step });
        // an assert step may have been appended after the click
        if (recorder.steps.length - 1 > index) send({ type: "step", index: recorder.steps.length - 1, step: recorder.steps[recorder.steps.length - 1] });
      } else if (message.type === "type") {
        const { index, step } = await recorder.type(String(message.text ?? ""));
        send({ type: "step", index, step, replace: true });
      } else if (message.type === "press") {
        const { index, step } = await recorder.press(String(message.key || "Enter"));
        send({ type: "step", index, step });
        if (recorder.steps.length - 1 > index) send({ type: "step", index: recorder.steps.length - 1, step: recorder.steps[recorder.steps.length - 1] });
      } else if (message.type === "scroll") {
        const { index, step } = await recorder.scroll(message.direction);
        send({ type: "step", index, step });
      }
    } catch (err) {
      send({ type: "error", message: err.message });
    } finally {
      busy = false;
    }
  }

  wss.on("connection", (socket) => {
    client = socket;
    send({ type: "ready", viewport: VIEWPORT });
    socket.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      handle(msg);
    });
    socket.on("close", () => { if (client === socket) client = null; });
    announcePage();
  });

  if (startUrl) {
    try { await recorder.navigate(/^[a-z][a-z0-9+.-]*:/i.test(startUrl) ? startUrl : `https://${startUrl}`); } catch (err) { /* surfaced on connect via blank page */ }
  }

  return { wss, port, recorder, page, close: shutdown };
}

module.exports = { startWebLiveView, VIEWPORT };
