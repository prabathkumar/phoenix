/**
 * POST /api/sessions — a tester uploads a .ipa/.apk directly through
 * frontend/index.html and TestOps Mobile starts a recording session against
 * it on demand, instead of the app being fixed by an env var before
 * run-session.js boots. See README's "Uploading an app directly"
 * section for the full flow and why cloud (BrowserStack) came first:
 * TestOps is already tightly integrated with it, so an uploaded file
 * just needs one more hop (browserstack-upload.js's uploadApp()) to
 * become a `bs://` reference — no local emulator/Simulator needed at
 * all. The local-provider path is also wired here (an uploaded file
 * becomes the appium:app path directly) but only works when this
 * process and the Appium server share a filesystem — see the caveat
 * below and in docs/SETUP.md.
 *
 * Split out of server.js because it pulls in engine/, capture/,
 * live-view/, and generation/ (session-manager.js's dependencies) —
 * server.js's own job (serving index.html) needs none of that.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Busboy = require("busboy");

const { startRecordingSession, isSessionActive } = require("../engine/session-manager");
const { uploadApp } = require("../engine/browserstack-upload");
const remoteProvider = require("../engine/remote-provider");

const UPLOAD_DIR = path.join(__dirname, "uploads");
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500MB — generous for a mobile app build

const EXTENSION_TO_PLATFORM = { ".ipa": "ios", ".apk": "android" };

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
function handleUploadAndStart(req, res) {
  if (isSessionActive()) {
    respondJson(res, 409, {
      error: "The session pool is full. Stop an active session before starting another, " +
        "or raise TESTOPS_MOBILE_SESSION_POOL_SIZE if more devices/slots are actually available.",
    });
    return;
  }

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  let busboy;
  try {
    busboy = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_UPLOAD_BYTES } });
  } catch (err) {
    respondJson(res, 400, { error: `Invalid upload request: ${err.message}` });
    return;
  }

  let savedPath = null;
  let originalName = null;
  let sizeLimitExceeded = false;
  let requestedPlatform = null; // optional form field, only needed if extension is ambiguous
  let fileWritePromise = Promise.resolve();

  busboy.on("field", (name, value) => {
    if (name === "platform") requestedPlatform = value;
  });

  busboy.on("file", (_name, fileStream, info) => {
    originalName = info.filename;
    const ext = path.extname(originalName || "").toLowerCase();
    const destPath = path.join(UPLOAD_DIR, `${crypto.randomUUID()}${ext}`);
    savedPath = destPath;

    fileStream.on("limit", () => {
      sizeLimitExceeded = true;
    });

    fileWritePromise = new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(destPath);
      fileStream.pipe(writeStream);
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
      fileStream.on("error", reject);
    });
  });

  busboy.on("error", (err) => {
    respondJson(res, 400, { error: `Upload failed: ${err.message}` });
  });

  busboy.on("finish", async () => {
    try {
      await fileWritePromise;
    } catch (err) {
      cleanup(savedPath);
      respondJson(res, 500, { error: `Failed to save uploaded file: ${err.message}` });
      return;
    }

    if (sizeLimitExceeded) {
      cleanup(savedPath);
      respondJson(res, 413, { error: `Uploaded file exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit.` });
      return;
    }
    if (!savedPath) {
      respondJson(res, 400, { error: "No file was uploaded (expected a multipart field named \"app\")." });
      return;
    }

    const ext = path.extname(originalName || "").toLowerCase();
    const platform = requestedPlatform === "ios" || requestedPlatform === "android"
      ? requestedPlatform
      : EXTENSION_TO_PLATFORM[ext];

    if (!platform) {
      cleanup(savedPath);
      respondJson(res, 400, {
        error: `Couldn't tell whether "${originalName}" is an Android or iOS build (expected a .apk or .ipa ` +
          `extension, or a "platform" form field set to "android"/"ios").`,
      });
      return;
    }

    try {
      const capabilityOverrides = await resolveAppCapability({ savedPath, platform });
      const session = await startRecordingSession({ platform, capabilityOverrides });
      respondJson(res, 200, {
        platform: session.platform,
        port: session.port,
        sessionId: session.sessionId,
      });
    } catch (err) {
      cleanup(savedPath);
      console.error("[upload-session] failed to start session:", err);
      respondJson(res, 502, { error: err.message });
    }
  });

  req.pipe(busboy);
}

/**
 * Turns a saved upload into whatever capabilityOverrides engine/session.js
 * or engine/ios-session.js's startSession() needs, depending on the
 * active TESTOPS_MOBILE_APPIUM_PROVIDER.
 */
async function resolveAppCapability({ savedPath, platform }) {
  if (remoteProvider.provider() === remoteProvider.BROWSERSTACK) {
    console.log(`[upload-session] uploading ${savedPath} to BrowserStack...`);
    const appUrl = await uploadApp(savedPath);
    console.log(`[upload-session] uploaded, got ${appUrl}`);
    // BrowserStack has its own copy now; the local file is no longer
    // needed (browserstack-upload.js sent its bytes, not a reference).
    cleanup(savedPath);
    return { "appium:app": appUrl };
  }

  // Local provider: the app path must be readable by whatever host is
  // actually running the Appium server. That's this same machine only
  // when frontend/server.js and `appium` are co-located — the same
  // constraint docs/SETUP.md already documents for TESTOPS_MOBILE_STAGE0_APP_PATH
  // and TESTOPS_MOBILE_IOS_APP_PATH today; an uploaded file doesn't relax it.
  const key = platform === "ios" ? "appium:app" : "appium:app";
  return { [key]: savedPath };
}

function cleanup(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, () => {}); // best-effort; a leftover upload isn't fatal
}

function respondJson(res, statusCode, body) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

module.exports = { handleUploadAndStart };
