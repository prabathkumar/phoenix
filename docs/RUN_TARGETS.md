# Where it ran: local or BrowserStack, Appium or Playwright

Every recording and every run now says where it happened. The label is informational: scripts replay the same
anywhere, and nothing here blocks a run.

```
{ engine: "appium" | "playwright", provider: "local" | "browserstack", platform,
  device?, osVersion?  (mobile)    browser?, browserVersion?, headless?  (web),
  host?, sessionId?, sessionUrl? }
```

Code: `engine/core/run-target.js`. Web launcher: `web/browser-provider.js`. Tests: `engine/test/run-target.test.js`,
`web/test/browser-provider.test.js`.

| Where | What you get |
|---|---|
| Recording (mobile) | `// Recorded on: BrowserStack · iPhone 15 · iOS 17 (provider=browserstack)` in the generated script; `recordedOn` in the `script-generated` message |
| Recording (web) | same header in the Playwright script, and `recordedOn` inside the test-case JSON |
| Execution | `ranOn` on every run result (`buildTestResult`), mobile and web; `warnings` when `recordedOn` differs from `ranOn` (different provider, device or browser). A flag, never a block |
| English page | a "Running on: BrowserStack · iPhone 15 · iOS 17 · Appium" chip with a link to the BrowserStack session |

Old test-case files and results without these fields behave exactly as before ("unknown", no warning).

## Choosing where a web test runs

The **Web** card on `/english` has **Run on: Chromium on TestOps / BrowserStack**. `POST /api/english-runs` takes
`runOn: "local" | "browserstack"` (default local). BrowserStack connects Playwright to BrowserStack's endpoint with
the server's `TESTOPS_MOBILE_BROWSERSTACK_USER` and `_KEY` (the same ones mobile uses); they travel only inside the
connection URL and are never returned or labelled. Without them the run stops with a plain message. Browser and
OS default to Chrome latest on Windows 11; pass a `target` with `browser`, `browserVersion`, `osVersion` to change it.

Mobile keeps using the server's `TESTOPS_MOBILE_APPIUM_PROVIDER`; a per-run choice for mobile is not built, because
that setting is process-wide by design (see `engine/remote-provider.js`).

## Recording on BrowserStack

The start screen's **Web** panel has **Record on: Chromium on TestOps / BrowserStack**. `POST /api/web-sessions` takes
`runOn` (and optionally `target`). On BrowserStack the recording browser is a BrowserStack browser, mirrored into the
same stage, and the script header and test-case JSON say `provider=browserstack`. It uses the server's
`TESTOPS_MOBILE_BROWSERSTACK_USER` / `_KEY`, costs BrowserStack minutes, and cannot open pages that are only on your
own network (BrowserStack Local is not set up for web yet). Replay CLI: `node web/run-web-test-case.js case.json --browserstack`;
a test case recorded elsewhere replays with a warning, never a failure.

## TestOps can pass the target in

TestOps already holds the BrowserStack integration and knows the device and session, so it can pass them instead
of the engine working them out: a `target` field on `POST /api/english-runs` and on the recording upload form, or
`ranOn` / `recordedOn` options on the runners. Only short plain whitelisted fields are kept (provider, engine,
platform, device, osVersion, browser, browserVersion, host, sessionId, an https sessionUrl, label); credentials and
anything else are dropped. What the engine can see for itself fills any gaps.

## Not verified

The BrowserStack web path (running and recording) is unit-tested with a stand-in Playwright and has not been run against a real BrowserStack
account from this sandbox. Try one run from your Mac before relying on it.
