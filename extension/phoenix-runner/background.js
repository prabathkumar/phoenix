// Phoenix Runner (Chrome extension). Dials OUT to the Phoenix hub; opens a tab in THIS Chrome (so VPN and SSO apply) and lets the tester see and use it from Phoenix.
// Live sessions only: recorded test cases and the AI goal loop need the laptop runner program (Playwright).
import { allowed } from "./allowlist.js";

const DEBUGGER_VERSION = "1.3";
const KEYS = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };
let ws = null, conf = {}, session = null, pingTimer = null, state = { connected: false, detail: "not connected" };

const say = (detail, connected = state.connected) => { state = { connected, detail }; try { chrome.storage.session.set({ state }); } catch { /* no session storage */ } };
const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const cdp = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);

async function loadConf() { conf = await chrome.storage.local.get(["server", "token", "runnerId", "allow", "enabled"]); }

function connect() {
  if (ws && ws.readyState <= 1) return;
  if (!conf.token || !conf.server || conf.enabled === false) return say("not paired or switched off", false);
  ws = new WebSocket(conf.server.replace(/^http/, "ws").replace(/\/$/, "") + "/api/runners/connect");
  ws.onopen = () => { send({ type: "auth", token: conf.token }); send({ type: "hello", os: "chrome-extension" }); say("connected to Phoenix", true); clearInterval(pingTimer); pingTimer = setInterval(() => send({ type: "ping", busy: !!session }), 20000); };
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
  ws.onclose = (e) => { clearInterval(pingTimer); say(e.code === 4401 ? "Phoenix refused this pairing (revoked?). Pair again in the extension settings." : "disconnected; retrying", false); ws = null; endSession("Phoenix connection lost"); };
  ws.onerror = () => say("could not reach Phoenix", false);
}

async function onMessage(m) {
  if (m.type === "job") {
    if (m.kind !== "live") return send({ type: "job-result", id: m.id, result: { success: false, status: "unsupported", detail: "The Chrome extension runs live sessions only. Use the laptop runner program for recorded test cases." } });
    if (session) return send({ type: "job-result", id: m.id, result: { success: false, status: "busy", detail: "this Chrome is already in a session" } });
    return startLive(m);
  }
  if (m.type === "live-in" && session && session.id === m.id) return handleInput(m.data);
  if (m.type === "live-stop" && session && session.id === m.id) return endSession("stopped");
  if (m.type === "revoked") { await chrome.storage.local.remove(["token", "runnerId"]); say("this pairing was revoked in Phoenix", false); endSession("revoked"); try { ws.close(); } catch { /* closed */ } }
}

const out = (id, obj) => send({ type: "live-out", id, data: JSON.stringify(obj) });

async function startLive(job) {
  if (!allowed(job.url, conf.allow)) return send({ type: "live-closed", id: job.id, reason: "the extension will not open that address (not in its allowed list)" });
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  const s = { id: job.id, tabId: tab.id, timer: null, mainFrame: null, w: 1280, h: 800, busy: false };
  session = s;
  try {
    await chrome.debugger.attach({ tabId: tab.id }, DEBUGGER_VERSION);
    await cdp(tab.id, "Page.enable");
    await cdp(tab.id, "Fetch.enable", { patterns: [{ resourceType: "Document" }] });     // only page loads are held, so the allowlist can refuse them
    s.mainFrame = (await cdp(tab.id, "Page.getFrameTree")).frameTree.frame.id;
    await cdp(tab.id, "Page.navigate", { url: job.url });
    s.timer = setInterval(() => frame(s), 800);
  } catch (e) { endSession("could not open the tab: " + String(e.message || e).slice(0, 120)); }
}

async function frame(s) {
  if (session !== s || s.busy) return;
  s.busy = true;
  try {
    const m = await cdp(s.tabId, "Page.getLayoutMetrics");
    s.w = m.cssVisualViewport.clientWidth; s.h = m.cssVisualViewport.clientHeight;
    const shot = await cdp(s.tabId, "Page.captureScreenshot", { format: "jpeg", quality: 60 });
    out(s.id, { type: "frame", mime: "image/jpeg", screenshotBase64: shot.data });
    const t = await chrome.tabs.get(s.tabId);
    if (t.url !== s.lastUrl || t.title !== s.lastTitle) { s.lastUrl = t.url; s.lastTitle = t.title; out(s.id, { type: "page", url: t.url, title: t.title }); }
  } catch { /* tab busy or closing */ } finally { s.busy = false; }
}

async function handleInput(raw) {
  const s = session; let m; try { m = JSON.parse(raw); } catch { return; }
  const t = s.tabId, no = (message) => out(s.id, { type: "action-error", message });
  try {
    if (m.type === "tap") { const x = m.xRatio * s.w, y = m.yRatio * s.h; for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp(t, "Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }); }
    else if (m.type === "type") { await cdp(t, "Input.insertText", { text: String(m.value || "") }); out(s.id, { type: "text-entered" }); }   // never stored or logged here, secret or not
    else if (m.type === "navigate") { if (!allowed(m.url, conf.allow)) return no("that address is not in this runner's allowed list"); await cdp(t, "Page.navigate", { url: m.url }); }
    else if (m.type === "scroll") await cdp(t, "Input.dispatchMouseEvent", { type: "mouseWheel", x: s.w / 2, y: s.h / 2, deltaX: 0, deltaY: m.direction === "up" ? -400 : 400 });
    else if (m.type === "press") { const vk = KEYS[m.key]; for (const type of ["keyDown", "keyUp"]) await cdp(t, "Input.dispatchKeyEvent", { type, key: m.key, code: m.key, windowsVirtualKeyCode: vk }); }
    else if (m.type === "stop") endSession("stopped");
    else if (m.type === "undo" || m.type === "ai-goal") no("Undo and the AI goal are not available in the Chrome extension. Use the laptop runner program for those.");
  } catch (e) { no(String(e.message || e).slice(0, 120)); }
}

function endSession(reason) {
  const s = session; if (!s) return; session = null; clearInterval(s.timer);
  try { chrome.debugger.detach({ tabId: s.tabId }); } catch { /* gone */ }
  try { chrome.tabs.remove(s.tabId); } catch { /* gone */ }
  send({ type: "live-closed", id: s.id, reason });
}

chrome.debugger.onEvent.addListener((src, method, p) => {
  if (!session || src.tabId !== session.tabId || method !== "Fetch.requestPaused") return;
  const block = p.resourceType === "Document" && p.frameId === session.mainFrame && !allowed(p.request.url, conf.allow);
  if (block) { cdp(session.tabId, "Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }).catch(() => {}); out(session.id, { type: "action-error", message: "blocked: that address is not in this runner's allowed list" }); }
  else cdp(session.tabId, "Fetch.continueRequest", { requestId: p.requestId }).catch(() => {});
});
chrome.debugger.onDetach.addListener((src) => { if (session && src.tabId === session.tabId) { const s = session; session = null; clearInterval(s.timer); send({ type: "live-closed", id: s.id, reason: "the debugging bar was closed in Chrome" }); } });
chrome.tabs.onRemoved.addListener((id) => { if (session && id === session.tabId) { const s = session; session = null; clearInterval(s.timer); try { chrome.debugger.detach({ tabId: id }); } catch { /* gone */ } send({ type: "live-closed", id: s.id, reason: "the tab was closed" }); } });

chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m && m.type === "reload") loadConf().then(() => { try { ws && ws.close(); } catch { /* closed */ } ws = null; connect(); reply({ ok: true }); });
  else if (m && m.type === "status") reply(state);
  else return false;
  return true;
});
chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && (ch.token || ch.server || ch.enabled)) loadConf().then(() => { try { ws && ws.close(); } catch { /* closed */ } ws = null; connect(); }); });
chrome.alarms.create("phoenix-reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async () => { await loadConf(); connect(); });
chrome.runtime.onStartup.addListener(async () => { await loadConf(); connect(); });
chrome.runtime.onInstalled.addListener(async () => { await loadConf(); connect(); });
loadConf().then(connect);
