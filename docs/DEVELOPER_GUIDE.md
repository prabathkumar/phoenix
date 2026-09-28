# Developer guide — recording and generating a test

This is for a tester or developer who wants to **record a flow and get
a runnable script out**, on a Phoenix instance someone else has already
stood up (see `docs/SETUP.md` if that's not the case yet — you need at
minimum a reachable live-view WebSocket and a frontend URL).

## 1. Open the recording UI

- **If your team hosts `run-session.js` publicly reachable**, open the
  public frontend: https://prabathkumar.github.io/phoenix/ — this is a
  static page auto-deployed from `frontend/index.html`, it needs no
  local setup on your machine at all.
  - If the backend isn't on the same machine as your browser, add
    `?host=<host>&port=<port>` to the URL, pointing at wherever
    `run-session.js`'s live-view WebSocket is reachable (ask whoever
    runs it, or see `docs/SETUP.md`'s tunnel note).
- **If you're running everything locally** (developing Phoenix itself,
  or testing against your own emulator), see `docs/SETUP.md` steps 1-5,
  then open `http://localhost:8091/` (or whatever `PHOENIX_FRONTEND_PORT`
  you set).

## 2. Record a flow

Once the page loads, you'll see a live mirror of the device screen.

- **Tap** anywhere on the mirrored screen to tap the same spot on the
  real device — Phoenix converts your click position into the device's
  actual coordinates automatically, so it works the same regardless of
  your browser window size.
- **Type** into a focused field using the text input Phoenix shows
  alongside the mirror.
- Every action you take appears in the **recorded steps** list as it
  happens, so you can see exactly what's been captured so far.
- When your flow is complete, click **"Stop & Generate Script"**.

There's no need to plan the whole flow in advance — record naturally,
the way an actual tester would use the app. Phoenix resolves a stable
locator for each tap (preferring resource-id, then accessibility-id,
then visible text, then a structural path, falling back to a raw
coordinate only when nothing else is available) and infers assertions
from what visibly changed on screen after each tap — you don't write
any of that yourself.

## 3. Get your script

After you click Stop, the generated script appears inline in the page
with a copy button — a runnable WebdriverIO test file, e.g.:

```js
describe("login", () => {
  it("login", async () => {
    const step0El = await $("android=new UiSelector().resourceId(\"...\")");
    await step0El.waitForDisplayed();
    await step0El.click();
    await step0El.setValue(username);
    // ...
    await expect($("...")).toBeDisplayed(); // "Welcome" appeared
  });
});
```

- Values you typed during recording (a username, a search term) are
  automatically lifted into named constants at the top of the file
  instead of hardcoded inline, so the same script is easy to re-run
  with different test data.
- Assertions are proposed automatically from whatever new text/labels
  appeared on screen right after each tap — review them; they're a
  starting point, not guaranteed to be exactly the assertions you'd
  write by hand.
- If your instance has the LLM refinement layer turned on
  (`PHOENIX_USE_LLM=1`, see `docs/SETUP.md`), the script's test name
  will summarize the whole flow rather than just naming it after the
  first screen, and a few incidental assertions (a clock or ad banner
  that happened to change) may already be filtered out for you.
- The same file is also written to the server's `generated/` folder as
  `<test-name>.test.js`, if you have file access to wherever
  `run-session.js` is running.

Copy the script into your test suite, adjust naming/assertions as
needed, and run it the same way you'd run any WebdriverIO Android test.

## Tips

- **A flow that fails partway through recording** (the app crashes, the
  emulator disconnects) doesn't corrupt anything — just refresh the
  page and start a new recording; nothing from the broken attempt is
  saved.
- **List rows with repeated labels** (a settings list where every row
  looks structurally similar) are still handled correctly — Phoenix
  combines the row's resource-id with its own text to pick out the
  exact row you tapped, not just "some row with this shared id".
- **Screens with no accessible labels** (custom-drawn canvas UI, some
  games) are a known rough edge — a tap there falls back to a raw
  screen coordinate in the generated script, which is more fragile
  than a resolved locator. This is one of the acknowledged open items,
  see the README's Status section.
- **Recording a custom iOS app and getting the same locator for every
  tap, with zero assertions?** The app's own views are missing
  accessibility identifiers — confirmed live against a real SwiftUI
  app where every tap resolved to the same top-level `~Orders` locator
  because that was the *only* accessible element XCUITest could see on
  screen. This isn't a Phoenix bug: without `.accessibilityIdentifier`
  (SwiftUI) or `accessibilityIdentifier` (UIKit) set on the app's
  buttons/rows/fields, no tool built on XCUITest — Phoenix included —
  can tell them apart. Check with Xcode's Accessibility Inspector
  (Open Developer Tool → Accessibility Inspector, hover the app on the
  booted Simulator) before recording; if it only ever reports the
  screen as a whole rather than individual controls, add identifiers
  to the app first.
- Questions about what a specific generated line means, or why an
  assertion looks off, are usually answered by looking at the actual
  accessibility tree for that screen (`adb shell uiautomator dump`, or
  ask whoever has server access to check `generated/<name>.test.js`
  alongside the recorded session).
