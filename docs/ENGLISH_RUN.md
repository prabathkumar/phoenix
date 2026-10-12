# Run from English

A test case written as plain English, run by the AI on a live web page or a real mobile app. Open `http://localhost:8091/english`.

Two independent cards:

| | Web | Mobile |
|---|---|---|
| Input | URL | app build (.apk/.ipa) or an already-uploaded `bs://` URL, Android/iOS |
| Runs on | Chromium on the server (free, no device) | a real BrowserStack device (costs session minutes) |
| AI used | shared goal loop (`engine/core/goal-loop.js`) over a Playwright surface | the hardware-tested autonomous loop (`engine/semantic-loop.js`) over Appium |

## Writing the test
One step per line. `${NAME}` is filled from the test-data table, e.g. `Enter ${LOGIN_PHONE} as the phone number`.
Names that look secret (password, pin, otp, token, tac, key ...) are masked in the table and never appear in progress, failure reasons or the event stream; the screen shows `${NAME}` instead. A `${NAME}` with no value stops the run before anything is clicked.

The run stops at the first failed step and marks the rest skipped, so the report says exactly which line failed and why. Every step carries a screenshot.

## Pieces
- `engine/core/english.js` - parse lines, fill/redact test data
- `engine/english-run.js` - one orchestrator, two adapters (`webRunner`, `mobileRunner`)
- `frontend/english-endpoint.js` - `POST /api/english-runs` (JSON for web, multipart for mobile) and `GET /api/english-runs/:id/events` (Server-Sent Events)
- `frontend/english.html` - the page

## Needs
Both cards need the model reachable (`ollama serve`, see SETUP). Mobile also needs the server started with the BrowserStack settings (`--env-file .env`, see DOCKER). One mobile run at a time.

## Not done yet
- Mobile does not yet share the web ladder (no `resolvedBy` tally, no promotable patches); it uses its own loop until an Appium surface adapter exists.
- A run's result is shown, not saved as a test case; "save this as a replayable script" is the next step.
