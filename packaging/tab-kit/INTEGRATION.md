# Add Phoenix Runner as another tab in the FrothTestOps Chrome extension

Two files, no build step, no dependencies. They never touch your existing storage keys, messages, alarms or tabs: everything is under the name `phoenixRunner`.

## 1. Copy the files
Put `phoenix-runner-core.js` and `phoenix-runner-tab.js` next to your extension's other scripts.

## 2. Background (service worker), once
- Module service worker (`"type": "module"` in manifest): add at the top level
  ```js
  import "./phoenix-runner-core.js";
  PhoenixRunner.start();
  ```
- Classic service worker: `importScripts("phoenix-runner-core.js"); PhoenixRunner.start();`

## 3. The tab
Add a tab (button + panel) in your popup or options page that contains an empty container, load the tab script, and mount it from a `.js` file (extension pages block inline scripts):
```html
<div id="phoenix-runner"></div>
<script src="phoenix-runner-tab.js"></script>
<script src="phoenix-runner-mount.js"></script>   <!-- contains: PhoenixRunnerTab.mount(document.getElementById("phoenix-runner")); -->
```
Mount it when your tab is first shown, or on page load; it is safe to mount while hidden.

## 4. Manifest: add (do not replace) these
See `manifest-additions.json`. If you already have `tabs`, `storage` or `alarms`, keep one copy. `debugger` is new: if your HAR recorder already uses it, nothing changes. Phoenix Runner opens its own tab for a session, so it does not interfere with a tab your recorders are using.
Update the store listing's permission justification (the `debugger` text) and the privacy answers: this feature connects only to the company's Phoenix server, keeps a pairing token in local extension storage, and sends screenshots and keystrokes of the tab the tester opens in a Phoenix session.

## 5. Check it works
1. Load unpacked. Open your popup, go to the Phoenix Runner tab, enter the Phoenix address and a pairing code (Phoenix > Laptop runners > Get a pairing code), press Pair. Chrome asks once to let the extension reach your Phoenix address: allow. (Chrome may close a popup when it shows that question: open it again and press Pair.)
2. In Phoenix > Live browser choose **My laptop**, pick the Chrome runner, enter an allowed address, Open browser.

Limits: live sessions only (no recorded test-case runs, no step recording, undo or AI goal: use the Phoenix Runner installer for those). The runner opens only addresses on the allowlist chosen when the pairing code was made.
