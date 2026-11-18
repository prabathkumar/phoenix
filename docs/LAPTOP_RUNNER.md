# Laptop runner: testing intranet and VPN apps from TestOps in AWS

TestOps (Phoenix) in AWS cannot reach an app that is only on a company intranet or VPN. The laptop runner fixes that without opening anything into your network: a small program on the tester's laptop connects **out** to Phoenix (WSS, port 443). Phoenix then sends it work, and the browser runs on the laptop, where the VPN is.

```
 tester's browser (Phoenix UI) <-- wss --> Phoenix hub (AWS) <-- wss (laptop dials out) --> runner on the laptop --> Chromium --> intranet app
```

## Two ways to install (both built)
**A. Installer zip (full runner: live sessions AND recorded test cases).** Build: `python3 packaging/build_packages.py --server https://<your-phoenix-address> --out dist` gives `dist/phoenix-runner-0.1.0.zip`. A tester unzips it, double-clicks **Install.command** (Mac) or **Install.bat** (Windows), then **Start.command** / **Start.bat**. The installer downloads Node 22 (checked against nodejs.org's published checksum) and Playwright's Chromium into the folder; no admin rights. The Phoenix address is baked in, so testers only type the pairing code. Plain-English steps are in the zip's `README-FIRST.txt`.

**B. Chrome extension (live sessions only).** `dist/phoenix-runner-chrome-0.1.0.zip` (from the same command). It drives the tester's own Chrome (VPN and SSO already there) through Chrome's debugging interface. Install: load unpacked for a try-out (`chrome://extensions` > Developer mode > Load unpacked > the `extension/phoenix-runner` folder), or upload the zip to the Chrome Web Store as a **private/unlisted** item, or have IT push it by policy (`ExtensionInstallForcelist`). Pair in the extension's settings page (Phoenix address + code). Chrome shows a "being debugged" bar on the tab while a session runs. Not supported in the extension: recorded test-case runs, step recording, undo and the AI goal; use package A for those. Permissions asked: debugger, tabs, storage, alarms, and (optional, at pairing) access to your Phoenix address only.

## Set up the developer way (once per laptop)
1. Phoenix UI > **Laptop runners** > list the addresses this laptop may open (`*.corp.example.com`, `intranet.corp.example.com`, `10.20.0.0/16`) > **Get a pairing code**.
2. On the laptop, in the Phoenix folder (Node 20+): `cd web && npm install && npx playwright install chromium`, then `cd ..`.
3. `node runner/phoenix-runner.js pair https://<your-phoenix-address> <code>` then `node runner/phoenix-runner.js start`. Leave it running.
4. Phoenix UI > **Live browser** > **My laptop** > pick the laptop > address > **Open browser**. A real browser opens on the laptop, is mirrored in the UI, and you click and type into it. Typed secrets stay on the laptop.

`node runner/phoenix-runner.js forget` removes the pairing from the laptop; **Revoke** in the UI cancels it on the server (and disconnects the runner).

## What it does
- **Live session:** same live view as the server browser (click, type, undo, ask the AI, make a test), shown through Phoenix with a one-time view ticket.
- **Test-case run:** `POST /api/runners/{id}/jobs {kind:"web-case", steps, baseUrl, testData}` runs recorded web steps on the laptop with the existing web runner and returns the result in `GET /api/runners/jobs/{id}`.

## Safeguards
- Outbound only; the laptop's live view binds to `127.0.0.1`; nothing listens on the network.
- Pairing code is single use and lasts 10 minutes. The runner token is stored on the server as a hash only, and in `~/.phoenix-runner.json` (mode 600) on the laptop.
- **Allowlist, default deny,** enforced on the server when a job is created and again on the laptop; cloud metadata and link-local ranges are always refused; wildcards like `*` or `*.com` and ranges wider than /8 cannot be registered. In a live session, navigations to hosts outside the list are blocked.
- A runner only serves its owner; one job at a time; jobs and live sessions are written to the audit log.
- Typed passwords and codes (the live view's "secret" box) are never written into steps, test data or scripts.

## Limits (be aware)
- **Tested here:** the unzipped package (fresh `npm install`, real Playwright browser, real hub) ran a 4-step web job and refused an address outside the allowlist; the Chrome extension, loaded in a real Chromium, connected, mirrored a page, clicked, typed, blocked a disallowed address and stopped (`extension/test/smoke.js`). **Not tested:** the Mac and Windows installer scripts themselves (the Windows ones were not run at all; the Mac shell scripts were only syntax-checked), the extension's settings page (Chrome's permission prompt needs a person), a Chrome Web Store upload, and a real VPN or SSO app.
- **Not run end to end on a real laptop with a real browser and VPN.** Tested: the hub (pairing, allowlist, relay, revoke) with fake runners; the real Node runner against a live hub with a stand-in browser; the allowlist in both languages. The live-view relay through the AWS load balancer needs WebSocket support (an ALB has it; check idle timeouts).
- Test-case runs check the URLs written in the steps and the base URL; a click that navigates somewhere else is blocked only in live sessions.
- Unsigned installers: Mac shows "cannot be opened" (right-click > Open) and Windows shows "protected your PC" (More info > Run anyway) until the files are signed with your company certificates.
- The pipeline's English-step `execution` stage does not run on a laptop yet; use Live browser or the `web-case` job.
- Chrome profile / SSO: the runner uses a fresh browser each time, so an SSO login is typed in the live session (as a secret) each time.
- Runners are listed per signed-in address, and Phoenix still trusts the `X-User` header (no real login yet).


## Adding it as a tab in an existing extension (FrothTestOps recorder)

`phoenix-runner-tab-kit-<version>.zip` holds two scripts (`phoenix-runner-core.js` for the background, `phoenix-runner-tab.js` for the tab) plus `INTEGRATION.md` and `manifest-additions.json`. Everything uses the single storage key `phoenixRunner`, so it does not touch the host extension's data. The stand-alone Chrome zip uses the same two files.
