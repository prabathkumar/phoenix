/**
 * Tester-facing recording UI — serves frontend/index.html and, since
 * the upload flow was added, POST /api/sessions (upload-session.js),
 * which lets a tester upload a .ipa/.apk directly and starts a
 * recording session against it on demand.
 *
 * No build step, no framework: index.html is a single self-contained
 * page (vanilla JS) that connects directly to the live-view WebSocket
 * a started session returns. This file exists so the page is served
 * over http:// instead of opened as file://, sidestepping any browser
 * origin quirks around WebSocket connections from local files.
 *
 * Run: cd frontend && npm install && node server.js
 * Then open: http://localhost:8091/
 *
 * (The older env-var-configured flow — set PHOENIX_STAGE0_APP_PATH etc.
 * and run `node run-session.js` before opening this page — still works
 * unchanged; see README's "Uploading an app directly" section for how
 * the two relate.)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const { handleUploadAndStart } = require("./upload-session");

const PORT = Number(process.env.PHOENIX_FRONTEND_PORT) || 8091;
const INDEX_PATH = path.join(__dirname, "index.html");

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/sessions") {
    handleUploadAndStart(req, res);
    return;
  }

  fs.readFile(INDEX_PATH, "utf8", (err, content) => {
    if (err) {
      res.writeHead(500);
      res.end("Failed to read index.html: " + err.message);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`[frontend] serving http://localhost:${PORT}/`);
  console.log("[frontend] upload a .ipa/.apk from the page to start a session, or set");
  console.log("[frontend] PHOENIX_STAGE0_APP_PATH/PHOENIX_IOS_APP_PATH/PHOENIX_BROWSERSTACK_APP_URL");
  console.log("[frontend] and run `node run-session.js` separately, as before.");
});
