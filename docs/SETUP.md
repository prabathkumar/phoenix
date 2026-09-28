# Infra setup guide

This is the one doc an infra engineer needs to stand Phoenix up from a
fresh `git clone` — no prior context on the codebase required. It
consolidates what's otherwise spread across the README's per-feature
sections.

## What you're standing up

Phoenix has two halves that live on different hardware:

1. **A host with real Android access** — an emulator (needs
   hardware/GPU acceleration) or a real device (USB). This is where
   Appium, ADB, and the app-under-test's `.apk` live. This cannot be
   containerized in a general-purpose way (see the Dockerfile's header
   comment) — treat it like any Appium device-farm node you may
   already run.
2. **The Phoenix Node services** — `run-session.js` (session + live-view
   + recorder + script generation) and `frontend/server.js` (the
   tester-facing UI, if not using the public GitHub Pages deploy).
   These can run anywhere with network access to (1) — bare metal, a
   VM, or the provided `Dockerfile`.

They talk over two connections: Phoenix's Node process to the Appium
server (`PHOENIX_APPIUM_HOST`/`PORT`), and a tester's browser to
Phoenix's live-view WebSocket (`PHOENIX_LIVE_VIEW_PORT`).

## 1. Prerequisites on the device host

- Node.js 20+
- Android SDK (`ANDROID_HOME` set, `platform-tools` and a `build-tools`
  version on PATH — Appium's UiAutomator2 driver needs `adb` and
  `aapt2`)
- A JDK (`JAVA_HOME` set)
- Either a running AVD emulator, or a real device connected and
  authorized over `adb`
- The `.apk` under test, at a path this host can read

```bash
npm i -g appium
appium driver install uiautomator2
sdkmanager --sdk_root=$ANDROID_HOME "build-tools;34.0.0"   # provides aapt2
```

Confirm the device is visible before going further:

```bash
adb devices   # should list your emulator/device as "device", not "unauthorized"
```

### iOS instead of (or alongside) Android

Phoenix also supports iOS via `appium-xcuitest-driver`, using the same
spawn-a-server model as Android — see `engine/ios-session.js` and
`engine/ios-stage0-session.js`. Prerequisites:

- macOS with Xcode installed, and at least one Simulator runtime
  downloaded (Xcode → Settings → Platforms)
- `xcrun simctl list devices` shows an available Simulator (boot one
  with `xcrun simctl boot "<device name>"` if none is booted)
- A built `.app` bundle for the Simulator (from `xcodebuild` or your
  CI), at a path this host can read

```bash
appium driver install xcuitest
```

Set in `.env`:
```
PHOENIX_PLATFORM=ios
PHOENIX_IOS_APP_PATH=/absolute/path/to/YourApp.app
PHOENIX_IOS_DEVICE_NAME=iPhone 15      # must match an installed Simulator
PHOENIX_IOS_PLATFORM_VERSION=17.5      # optional if only one iOS version of that device is installed
```

Verify the iOS path in isolation first, the same way the Android
embedded path was verified — this proves the driver/session plumbing
works before layering the rest of the pipeline on top:

```bash
cd engine
npm run ios-stage0   # needs appium running (step 2 below) + a booted Simulator
```

Everything from step 2 onward (running Appium, `run-session.js`, the
frontend) works identically for iOS — `PHOENIX_PLATFORM=ios` in `.env`
is what switches `run-session.js` to the iOS engine and selector syntax.
No separate frontend or live-view server is needed for iOS.

## 2. Start Appium on the device host

```bash
appium   # binds 0.0.0.0:4723 by default — restrict this in production
         # (firewall / bind to a private network), it has no auth of its own
```

Leave this running. If Phoenix's Node services run on a *different*
host than this one, make sure that host's IP:4723 is reachable across
whatever network/VPN/firewall sits between them.

## 2b. Or: skip your own device host entirely and use BrowserStack

Steps 1-2 above assume you're standing up your own Android emulator or
iOS Simulator plus a local Appium server. If TestOps runs on Linux VMs,
that's a hard wall for iOS specifically — Xcode and the iOS Simulator
only run on macOS at all, and Apple's license rules out virtualizing
macOS on non-Apple hardware, so there's no way to stand one up directly
on a Linux host. Renting or racking dedicated Mac hardware works, but
if your org already pays for BrowserStack App Automate, pointing
Phoenix at that instead avoids the extra ongoing Mac cost.

This needs no code changes to use — `engine/session.js` and
`engine/ios-session.js` have always talked to Appium over a plain
hostname/port rather than assuming `localhost`, and
`engine/remote-provider.js` is what teaches them BrowserStack's
specific connection shape (HTTPS, a fixed hub hostname, account auth,
a `bstack:options` capability block) and app-reference format (an
uploaded app's `bs://` URL, not a local file path or a bundle id
already installed on a device you booted yourself).

1. Upload your app build once (re-upload only when the build changes,
   not per session):
   ```bash
   export PHOENIX_BROWSERSTACK_USER=<your BrowserStack username>
   export PHOENIX_BROWSERSTACK_KEY=<your Automate access key, not your password>
   node engine/browserstack-upload.js /path/to/app.ipa   # or .apk
   # prints a bs://<id> URL — set it below
   ```
2. Point Phoenix at BrowserStack instead of a local Appium server:
   ```bash
   export PHOENIX_APPIUM_PROVIDER=browserstack
   export PHOENIX_BROWSERSTACK_APP_URL=bs://<id from step 1>
   # PHOENIX_APPIUM_HOST/PORT are ignored under this provider
   ```
3. `PHOENIX_IOS_DEVICE_NAME`/`PHOENIX_IOS_PLATFORM_VERSION` (or
   Android's equivalent capabilities) now mean "which of BrowserStack's
   real-device catalog to request", not "which Simulator/emulator to
   boot" — BrowserStack App Automate runs real physical devices for
   iOS, not simulators.
4. Skip steps 1-2 above entirely (no local emulator, no local Appium
   server needed) and continue from step 3 ("Configure Phoenix") for
   everything else — `run-session.js`, the frontend, and the rest of
   the pipeline don't know or care where the session actually runs.

Optional: `PHOENIX_BROWSERSTACK_PROJECT` / `_BUILD` / `_SESSION_NAME`
label the session in BrowserStack's dashboard (defaults to "Phoenix" /
"phoenix-recording" / "Phoenix recording session" if unset).

## 3. Configure Phoenix

```bash
cd /path/to/phoenix    # the repo root — must contain run-session.js directly
cp .env.example .env
```

**`cp` only copies the template — it does not fill anything in.** Edit
`.env` and replace every placeholder value before going further. At
minimum:

- `PHOENIX_STAGE0_APP_PATH` — path to the `.apk`, **as seen by the
  Appium server's host**, not by wherever Phoenix's Node services run
  (Appium installs and launches it, not us). Still says
  `/absolute/path/to/your-app.apk`? It won't work — Appium will fail
  with "does not exist or is not accessible".
- `PHOENIX_APPIUM_HOST` / `PHOENIX_APPIUM_PORT` — where step 2's
  server is listening, from the Node services' point of view (e.g. the
  device host's LAN IP if they're on separate machines; `127.0.0.1` if
  co-located)

You can edit `.env` in any text editor, or from the terminal:

```bash
sed -i '' 's|PHOENIX_STAGE0_APP_PATH=/absolute/path/to/your-app.apk|PHOENIX_STAGE0_APP_PATH=/real/path/to/app.apk|' .env
```
(macOS/BSD `sed` needs the empty `-i ''`; on Linux use `sed -i` with no argument after it.)

See `.env.example` for every variable and what reads it.

Phoenix's scripts don't auto-load `.env` — export it into your shell or
process manager first, **from the same directory as `.env`**:

```bash
export $(grep -v '^#' .env | xargs)
```

Sanity-check it actually loaded your real values, not leftover
placeholders or a stale shell export:

```bash
echo $PHOENIX_STAGE0_APP_PATH   # should print YOUR apk path, not a placeholder
```

## 4. (Optional) LLM refinement layer — Ollama

Skip this section entirely if you're not using it — Phoenix's rule-based
generation (step 5 below) works standalone with `PHOENIX_USE_LLM` unset
or `0`.

To turn it on:

1. Install [Ollama](https://ollama.com) on whichever host runs
   `run-session.js`, and pull a model:
   ```bash
   ollama pull llama3
   ```
2. Confirm it's serving (Ollama often runs as a background service
   already — don't assume you need to start it manually):
   ```bash
   curl http://localhost:11434/api/tags   # should list your pulled model(s)
   ```
   If that fails with a connection error, start it: `ollama serve`. If
   instead you get "address already in use", it's already running —
   proceed.
3. In `.env`, set:
   ```
   PHOENIX_USE_LLM=1
   PHOENIX_OLLAMA_HOST=http://localhost:11434
   PHOENIX_OLLAMA_MODEL=llama3
   ```
   Re-run `export $(grep -v '^#' .env | xargs)` after editing.

Any failure here (Ollama not running, wrong host/model, a timeout) is
caught internally and Phoenix silently falls back to the rule-based
result — see `generation/llm.js`. Turning this on can never break a
recording session, only change how the generated script is named and
which assertions it keeps.

## 5. Run the Node services

Every path below needs the same dependencies installed first:

```bash
cd engine && npm install && cd ..
cd capture && npm install && cd ..
cd generation && npm install && cd ..
cd live-view && npm install && cd ..
cd frontend && npm install && cd ..
```

**Option A — a tester uploads the app directly (no `PHOENIX_STAGE0_APP_PATH`/`PHOENIX_IOS_APP_PATH`/`PHOENIX_BROWSERSTACK_APP_URL` needed):**

```bash
node frontend/server.js
```

That's the only process to start — `frontend/server.js` now starts a
recording session on demand per upload (`POST /api/sessions`, see
`frontend/upload-session.js`), instead of needing a separately-started
`run-session.js` pinned to one pre-chosen app. This is the path to use
once step 2 or 2b above is done (an Appium server or BrowserStack
credentials already configured) — a tester just opens the page and
drags in a `.apk`/`.ipa`. Under the BrowserStack provider this needs
no local emulator/Appium host at all, confirmed against a real
BrowserStack account (see README's "Uploading an app directly"
section). Under the local provider, the uploaded file's path is passed
straight to Appium as `appium:app` — this only works when
`frontend/server.js` and the Appium server share a filesystem, so it's
Option B below for a split host setup.

**Option B — the app is already fixed by an env var (the original flow, or a split host setup):**

```bash
node run-session.js        # starts the session + live-view + recorder + generation pipeline
```

Then, **in a second terminal, from the same repo root**:

```bash
node frontend/server.js    # only if not using the public GitHub Pages URL
```

Open the frontend with `?port=8090` (or whatever `PHOENIX_LIVE_VIEW_PORT`
is) so it skips the upload screen and connects straight to the
already-started session — e.g. `http://localhost:8091/?port=8090`.

If either command fails with `Cannot find module '.../run-session.js'`
or `.../frontend/server.js'`, you're in the wrong directory — both must
be run from the repo root (`run-session.js` and the `frontend/` folder
are direct children of it, not of `engine/`).

If `frontend/server.js` fails with `EADDRINUSE: address already in use
:::8091`, a previous instance is still running on that port. Find and
either reuse or kill it:
```bash
lsof -i :8091      # last column is the PID
kill <PID>         # then re-run node frontend/server.js
```

**Option C — via Docker** (packages `run-session.js`'s dependencies
only, see the Dockerfile's header comment for what's intentionally out
of scope):

```bash
docker build -t phoenix .
docker run --rm -p 8090:8090 --env-file .env phoenix
# frontend, if needed, as a second container:
docker run --rm -p 8091:8091 --env-file .env phoenix node frontend/server.js
```

## 6. Verify

- **Option A (upload flow):** open `http://localhost:<PHOENIX_FRONTEND_PORT>`,
  drag in a `.apk`/`.ipa`, and click "Start recording session" — the
  terminal running `frontend/server.js` should log
  `[session-manager] session started: <id>` within a few seconds
  (BrowserStack) to a minute or so (a large upload). If it errors
  immediately with a BrowserStack auth/app-url message, re-check step 2b's
  env vars are exported in *that* terminal, not just an earlier one.
- **Option B (env-var flow):** `run-session.js` should log
  `[session-manager] session started: <id>` (or `[run-session]`'s own
  startup lines around it) — if it hangs or errors here, the problem is
  almost always steps 1-3 (device host unreachable, wrong `.apk` path,
  or wrong `PHOENIX_APPIUM_HOST`/`PORT`), not Phoenix's own code. Then
  open the frontend (either `http://localhost:<PHOENIX_FRONTEND_PORT>/?port=<PHOENIX_LIVE_VIEW_PORT>`
  from step 5, or the public URL at
  https://prabathkumar.github.io/phoenix/ pointed at your live-view
  host via `?host=&port=`) and confirm the device mirror renders and
  taps register.
- Alternatively, drive it headlessly with
  `node live-view/test-client.js` (see `.env.example` for
  `PHOENIX_TAP_SEQUENCE`) and confirm a script lands in `generated/`.
  This only exercises Option B's env-var-configured session (it
  connects to an already-running `run-session.js`), not the upload flow.

## Notes for CI / automated environments

The `test.yml` GitHub Actions workflow runs `capture/` and
`generation/`'s own unit test suites (rule-based logic against fixed
accessibility-tree fixtures) — it does **not** spin up an emulator or
Appium server, so it doesn't prove the end-to-end path. There is
currently no CI job that exercises `run-session.js` or the embedded
path against a real emulator; that verification is manual (see the
README's "Appium fork work" section for how it was last confirmed).
