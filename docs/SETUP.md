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

## 2. Start Appium on the device host

```bash
appium   # binds 0.0.0.0:4723 by default — restrict this in production
         # (firewall / bind to a private network), it has no auth of its own
```

Leave this running. If Phoenix's Node services run on a *different*
host than this one, make sure that host's IP:4723 is reachable across
whatever network/VPN/firewall sits between them.

## 3. Configure Phoenix

```bash
cp .env.example .env
```

At minimum, set:

- `PHOENIX_STAGE0_APP_PATH` — path to the `.apk`, **as seen by the
  Appium server's host**, not by wherever Phoenix's Node services run
  (Appium installs and launches it, not us)
- `PHOENIX_APPIUM_HOST` / `PHOENIX_APPIUM_PORT` — where step 2's
  server is listening, from the Node services' point of view (e.g. the
  device host's LAN IP if they're on separate machines; `127.0.0.1` if
  co-located)

See `.env.example` for every variable and what reads it.

Phoenix's scripts don't auto-load `.env` — export it into your shell or
process manager first:

```bash
export $(grep -v '^#' .env | xargs)
```

## 4. Run the Node services

**Option A — directly:**

```bash
cd engine && npm install && cd ..
cd capture && npm install && cd ..
cd generation && npm install && cd ..
cd live-view && npm install && cd ..

node run-session.js        # starts the session + live-view + recorder + generation pipeline
node frontend/server.js    # separate terminal, if not using the public GitHub Pages URL
```

**Option B — via Docker** (packages `run-session.js`'s dependencies
only, see the Dockerfile's header comment for what's intentionally out
of scope):

```bash
docker build -t phoenix .
docker run --rm -p 8090:8090 --env-file .env phoenix
# frontend, if needed, as a second container:
docker run --rm -p 8091:8091 --env-file .env phoenix node frontend/server.js
```

## 5. Verify

- `run-session.js` should log `[run-session] session started: <id>` —
  if it hangs or errors here, the problem is almost always steps 1-3
  (device host unreachable, wrong `.apk` path, or wrong
  `PHOENIX_APPIUM_HOST`/`PORT`), not Phoenix's own code.
- Open the frontend (either `http://localhost:<PHOENIX_FRONTEND_PORT>`
  from step 4, or the public URL at
  https://prabathkumar.github.io/phoenix/ pointed at your live-view
  host via `?host=&port=`) and confirm the device mirror renders and
  taps register.
- Alternatively, drive it headlessly with
  `node live-view/test-client.js` (see `.env.example` for
  `PHOENIX_TAP_SEQUENCE`) and confirm a script lands in `generated/`.

## Notes for CI / automated environments

The `test.yml` GitHub Actions workflow runs `capture/` and
`generation/`'s own unit test suites (rule-based logic against fixed
accessibility-tree fixtures) — it does **not** spin up an emulator or
Appium server, so it doesn't prove the end-to-end path. There is
currently no CI job that exercises `run-session.js` or the embedded
path against a real emulator; that verification is manual (see the
README's "Appium fork work" section for how it was last confirmed).
