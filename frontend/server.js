/**
 * Tiny static server for frontend/index.html — the actual tester-facing
 * recording UI, replacing live-view/test-client.js's simulated tester.
 *
 * No build step, no framework: index.html is a single self-contained
 * page (vanilla JS) that connects directly to run-session.js's
 * live-view WebSocket. This file exists only so the page is served over
 * http:// instead of opened as file://, sidestepping any browser origin
 * quirks around WebSocket connections from local files.
 *
 * Run: node frontend/server.js
 * Then open: http://localhost:8091/  (with run-session.js already running)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PHOENIX_FRONTEND_PORT) || 8091;
const INDEX_PATH = path.join(__dirname, "index.html");

const server = http.createServer((req, res) => {
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
  console.log("[frontend] (make sure run-session.js is already running)");
});
