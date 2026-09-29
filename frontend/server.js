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
 *
 * POST /api/semantic-action (frontend/semantic-action-endpoint.js) is
 * an EXPERIMENTAL, opt-in endpoint for Phase 2's semantic action layer
 * (docs/PHOENIX_SPEC.md §6) — only registered when
 * PHOENIX_ENABLE_SEMANTIC_API=1 is set, off by default. See that
 * module's header for why it's gated: it's never been run against a
 * real device, and dev-team adoption of the semantic layer is
 * deliberately being held until that's proven.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const { handleUploadAndStart } = require("./upload-session");

const PORT = Number(process.env.PHOENIX_FRONTEND_PORT) || 8091;
const INDEX_PATH = path.join(__dirname, "index.html");
const SEMANTIC_API_ENABLED = process.env.PHOENIX_ENABLE_SEMANTIC_API === "1";

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/sessions") {
    handleUploadAndStart(req, res);
    return;
  }

  if (SEMANTIC_API_ENABLED && req.method === "POST" && req.url === "/api/semantic-action") {
    // Lazily required so the executor/session-manager/generation chain
    // it pulls in is only loaded when this experimental path is
    // actually turned on.
    require("./semantic-action-endpoint").handleSemanticAction(req, res);
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
  if (SEMANTIC_API_ENABLED) {
    console.log("[frontend] PHOENIX_ENABLE_SEMANTIC_API=1 set — POST /api/semantic-action is live (experimental, unproven on real hardware).");
  }
});
