#!/usr/bin/env node
/**
 * One-time (per app build) uploader for BrowserStack App Automate.
 *
 * BrowserStack has no concept of "a file already on this machine" or
 * "a bundle id already installed on a device" the way a local Appium
 * server does — remote-provider.js's TESTOPS_MOBILE_BROWSERSTACK_APP_URL must
 * be a `bs://<id>` reference to an app BrowserStack already has, which
 * only exists after it's been uploaded through their REST API. This
 * script does that upload and prints the resulting bs:// URL to set as
 * TESTOPS_MOBILE_BROWSERSTACK_APP_URL.
 *
 * Upload once per app build, not once per recording session — a bs://
 * id stays valid across many sessions until you upload a newer build.
 *
 * Usage:
 *   TESTOPS_MOBILE_BROWSERSTACK_USER=... TESTOPS_MOBILE_BROWSERSTACK_KEY=... \
 *     node engine/browserstack-upload.js /path/to/app.ipa
 *
 * API reference: https://www.browserstack.com/docs/app-automate/api-reference/appium/apps
 */

const fs = require("fs");
const path = require("path");

const UPLOAD_URL = "https://api-cloud.browserstack.com/app-automate/upload";

async function uploadApp(filePath, { user, key } = {}) {
  const username = user || process.env.TESTOPS_MOBILE_BROWSERSTACK_USER;
  const accessKey = key || process.env.TESTOPS_MOBILE_BROWSERSTACK_KEY;

  if (!username || !accessKey) {
    throw new Error(
      "Set TESTOPS_MOBILE_BROWSERSTACK_USER and TESTOPS_MOBILE_BROWSERSTACK_KEY (an Automate access key " +
        "from your BrowserStack account settings) before uploading."
    );
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`No such file: ${filePath}`);
  }

  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(filePath)]), path.basename(filePath));

  const auth = Buffer.from(`${username}:${accessKey}`).toString("base64");
  const response = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body: form,
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `BrowserStack upload failed (HTTP ${response.status}): ${JSON.stringify(body)}`
    );
  }
  if (!body.app_url) {
    throw new Error(`BrowserStack upload response had no app_url: ${JSON.stringify(body)}`);
  }

  return body.app_url; // e.g. "bs://abcd1234..."
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node engine/browserstack-upload.js /path/to/app.ipa");
    process.exitCode = 1;
    return;
  }

  try {
    const appUrl = await uploadApp(filePath);
    console.log(appUrl);
    console.error(`\nUploaded. Set this before starting a session:\n  export TESTOPS_MOBILE_BROWSERSTACK_APP_URL=${appUrl}`);
  } catch (err) {
    console.error(`[browserstack-upload] ${err.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { uploadApp };
