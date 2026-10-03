# End-to-end checklist — `addons` flow, real device evidence only

This tracks exactly one thing: for the `addons` test case (login → dismiss
post-login dialogs/tutorial → view Add-ons → log out), which steps have
actually been proven against a real device/BrowserStack session, and which
haven't. "Tested" here means a real run's log showed the step resolve and
act correctly — not "code reviewed," not "unit tested," not "should work."
Unit/code-level coverage for the supporting engine code (confidence gate,
locator store, MCP connector) is tracked separately in `docs/STATUS.md`;
this file is about the app flow only.

**Focus right now: get iOS to a first fully clean run, the same way Android
already got one.** Android closed end to end already (see
`docs/STATUS.md`'s "first clean, evidence-confirmed end-to-end pass"); iOS
has never completed the flow once.

## Android (`test-cases/addons.json`) — ✅ fully closed

| # | Step | Status |
|---|------|--------|
| 0 | Tap LOGIN (home screen) | ✅ Tested — real run |
| 1 | Close More-menu overlay (optional) | ✅ Tested — real run |
| 2 | Tap LOGIN (submit form) | ✅ Tested — real run |
| 3 | Type phone number | ✅ Tested — real run |
| 4 | Tap PASSWORD tab | ✅ Tested — real run |
| 5 | Tap password field | ✅ Tested — real run |
| 6 | Type password | ✅ Tested — real run |
| 7 | Submit LOGIN | ✅ Tested — real run |
| 8 | Wait for submission / permission dialog | ✅ Tested — real run |
| 9 | Dismiss Allow/permission dialog | ✅ Tested — real run |
| 10–18 | Tutorial coach-marks / carousel / popups | ✅ Tested — real run |
| 19 | Dismiss "Turn on Notifications" popup | ✅ Tested — real run |
| 20 | Tap Add-ons tab | ✅ Tested — real run |
| 21 | Close Add-ons purchase popup | ✅ Tested — real run |
| 22 | Open Profile/Account menu | ✅ Tested — real run |
| 23 | Scroll to reveal Logout | ✅ Tested — real run |
| 24 | Tap LOGOUT icon | ✅ Tested — real run (bug #18 fixed: now outcome-verified, not just "no error") |
| 25 | Confirm logout (YES) | ✅ Tested — real run |

Also proven on Android, separately: the Docker image end to end (`docs/STATUS.md`
"Docker image... verified end to end"), cross-run negative-selector caching,
and `expect` outcome verification on 12 of the 26 steps.

## iOS (`test-cases/addons.ios.json`) — ❌ not yet closed

| # | Step | Status | Notes |
|---|------|--------|-------|
| 0 | Dismiss notification-permission dialog (optional) | ✅ Tested — real run | Pinned selector (bug #7 fix) |
| 1 | Tap LOGIN (home screen) | ✅ Tested — real run | Pinned selector |
| 2 | Type phone number | ⚠️ Fix applied, NOT yet re-run | Bug #10 (run 17) — pinned `class-chain` selector from real evidence; unverified since |
| 3 | Tap PASSWORD button | ✅ Tested — real run | Pinned selector (bug #6) |
| 4 | Tap secure password field | ✅ Tested — real run | Pinned selector (bug #9, run 16) |
| 5 | Type password | ⚠️ Fix applied proactively, NOT yet run at all | Pinned selector this session from run 16's evidence, by inference — never itself reached/failed in a real run |
| 6 | Submit LOGIN | ❌ Untested | Never reached |
| 7 | Wait for submission/dialog | ❌ Untested | Never reached |
| 8 | Dismiss Allow/permission dialog (optional) | ❌ Untested | Never reached |
| 9 | Close coach-mark popup (optional) | ❌ Untested | Never reached |
| 10–15 | Advance tutorial carousel ×6 (optional) | ❌ Untested | Never reached |
| 16 | Close coach-mark popup (optional) | ❌ Untested | Never reached |
| 17 | Dismiss "Turn on Notifications" popup (optional) | ❌ Untested | Never reached |
| 18 | Tap Add-ons tab | ❌ Untested | Never reached |
| 19 | Close Add-ons purchase popup (optional) | ❌ Untested | Never reached |
| 20 | Open Profile/Account menu (optional) | ❌ Untested | Never reached |
| 21 | Scroll to reveal Logout (optional) | ❌ Untested | Never reached |
| 22 | Tap LOGOUT icon (optional) | ❌ Untested | Never reached |
| 23 | Confirm logout YES (optional) | ❌ Untested | Never reached |

**Furthest any iOS run has gotten: step 4 (run 16), before regressing to
step 2 on run 17** (an infra change — Node version/CI — not an app
regression; same LLM-variance failure class, different field).

## Supporting infrastructure — real-device proof status

| Component | Status | Notes |
|---|---|---|
| CI pipeline (`.github/workflows/test.yml`) | ✅ Green | Confirmed via `gh api` after Node 20→22 fix |
| Docker image build (Node 22, pinned digest) | ✅ Confirmed | Real `docker pull`/digest check done on the user's machine |
| `check-env.js` pre-flight | ✅ Confirmed | Run for real against the user's actual `.env` |
| `engine/locator-store.js` (SQLite) | ❌ Never recorded a row from a real run | Blocked twice: Node 20 (fixed), then a volume-mount gap (`touch locator-store.db` before first run — fix identified, not yet exercised) |
| Confidence gate (pin-on-evidence) | ❌ Never exercised on a real run | Unit-tested only so far |
| `mcp/server.js` connector | ❌ Never used by a real external MCP client | Proven via unit tests + a local stdio smoke test only |

## What "done" looks like for this focus

1. Run 18 (or later) gets past the now-pinned steps 2, 4, and 5 with zero
   LLM declines on those fields (confirms the pinning approach, not just
   the specific selectors).
2. The run reaches submit (step 6) and beyond for the first time ever.
3. Whatever breaks next gets the same treatment: real captured XML →
   zero-cost local replay through `buildGroundedSnapshot()` → pin or
   reword from evidence, never a guess.
4. Repeat until step 23 (logout confirm) is reached and verified — that's
   the iOS equivalent of Android's already-closed clean run.
5. Only once the flow itself is clean does it make sense to also confirm
   the locator-store volume mount and MCP connector end to end — they're
   independent of the app flow and shouldn't distract from closing it.
