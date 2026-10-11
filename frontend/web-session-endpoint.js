/**
 * POST /api/web-sessions {url, name?} -> starts a web recording (Chromium on
 * this machine, mirrored over WebSocket) and returns {port}. No BrowserStack
 * session involved, so it costs nothing and has no device latency.
 */
const net = require("net");
const { startWebLiveView } = require("../web/recorder/web-live-view");

const live = new Set();

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
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

module.exports = { handleStartWebSession };
