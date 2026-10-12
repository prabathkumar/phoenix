/**
 * POST /api/web-sessions {url, name?} -> starts a web recording (Chromium on
 * this machine, mirrored over WebSocket) and returns {port}. No BrowserStack
 * session involved, so it costs nothing and has no device latency.
 */
const net = require("net");
const { startWebLiveView } = require("../web/recorder/web-live-view");

const live = new Set();

function tryListen(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(port, () => { const { port: got } = srv.address(); srv.close(() => resolve(got)); });
  });
}

/**
 * A free port for the live-view WebSocket. Locally any port will do (random). In a
 * container only published ports are reachable, so TESTOPS_MOBILE_WEB_PORT_RANGE
 * ("8092-8099") restricts the choice to the range the image exposes.
 */
async function freePort(range = process.env.TESTOPS_MOBILE_WEB_PORT_RANGE) {
  const m = String(range || "").match(/^(\d+)-(\d+)$/);
  if (!m) return tryListen(0);
  for (let p = Number(m[1]); p <= Number(m[2]); p += 1) {
    try { return await tryListen(p); } catch { /* busy: try the next one */ }
  }
  throw new Error(`no free port in ${range} - close an open web recording or widen TESTOPS_MOBILE_WEB_PORT_RANGE`);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

async function handleStartWebSession(req, res, start = startWebLiveView) {
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  try {
    const { url, name } = await readJson(req);
    if (!url || typeof url !== "string") return send(400, { error: "A start URL is required." });
    const port = await freePort();
    const session = await start({ port, startUrl: url, name: name || "recorded_web_flow" });
    live.add(session);
    session.wss.on("close", () => live.delete(session));
    send(200, { port });
  } catch (err) {
    send(500, { error: `Could not start the browser: ${err.message}` });
  }
}

module.exports = { handleStartWebSession, freePort };
