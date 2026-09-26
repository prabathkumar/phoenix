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

**Option A — directly:**

```bash
cd engine && npm install && cd ..
cd capture && npm install && cd ..
cd generation && npm install && cd ..
cd live-view && npm install && cd ..

node run-session.js        # starts the session + live-view + recorder + generation pipeline
```

Then, **in a second terminal, from the same repo root**:

```bash
node frontend/server.js    # only if not using the public GitHub Pages URL
```

If either command fails with `Cannot find module '.../run-session.js'`
or `.../frontend/server.js`, you're in the wrong directory — both must
be run from the repo root (`run-session.js` and the `frontend/` folder
are direct children of it, not of `engine/`).

If `frontend/server.js` fails with `EADDRINUSE: address already in use
:::8091`, a previous instance is still running on that port. Find and
either reuse or kill it:
```bash
lsof -i :8091      # last column is the PID
kill <PID>         # then re-run node frontend/server.js
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

## 6. Verify

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
