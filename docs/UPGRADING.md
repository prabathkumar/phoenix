# Upgrading Playwright and Appium

TestOps ai-automate rides on two engines that move on their own schedule:
**Playwright** (web) and **Appium + WebdriverIO + drivers** (mobile). When either
ships an upgrade, we upgrade too - on purpose, in one small change, with proof.

## When to check
- Start of every sprint, and before any release: `node scripts/check-upgrades.js`
- Whenever BrowserStack announces an Appium or device-OS change, or a Playwright
  browser build stops matching (the symptom is "Executable doesn't exist").

## Routine (same for both engines)
1. `node scripts/check-upgrades.js` - note which are behind and whether it is a major.
2. Read the changelog for breaking changes (Playwright release notes; Appium 3 /
   driver release notes; WebdriverIO migration guide).
3. Bump in `web/package.json` or `engine/package.json`, then `npm install` there.
4. Web: `npx playwright install chromium`, then run `cd web && npm test` with
   real Chromium (tests skip silently without it - make sure they ran).
5. Mobile: run `engine` and `live-view` suites, then ONE real BrowserStack smoke
   (record 2-3 taps, generate, replay). Hardware behaviour is not covered by unit tests.
6. Update `docs/STATUS.md` (version table) and the Docker image tag if the
   browser build changed; rebuild the image.
7. One commit per engine: "Upgrade Playwright to X" / "Upgrade Appium to Y".

## Where an upgrade can hurt us
- The `Surface` adapter (`web/surface/`) and `web/recorder/locate.js` are the only
  Playwright-specific layers the Semantic and AI layers touch; the Appium-specific
  code lives behind `live-view/` and `engine/`. Upgrades are confined there.
- Tap injection (W3C actions) and screenshot size handling on Appium.
- Playwright locator semantics (`getByRole` name matching, `.nth`).
