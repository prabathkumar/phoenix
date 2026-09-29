# Project Phoenix — TestOps Mobile

**Codename:** Phoenix
**Product name (external):** TestOps Mobile
**Owner:** Prabath / FrothTestOps
**Status:** Stage 0 — not yet started

---

## 1. What Phoenix is

A proprietary mobile test-recording and generation engine for TestOps. Testers never touch Appium Inspector, never install anything locally, never see BrowserStack directly. They open TestOps, pick an app, record a flow once inside the product, and get a working automated script out the other end.

Underneath, Phoenix is built on a fork of Appium's core engine, extended with an AI-native layer that Appium doesn't have. Appium is Apache 2.0 licensed — forking, modifying, and closing the source of changes is legally clean.

**What Phoenix is not, yet:** a fully autonomous "upload the app and walk away" system. That's the eventual direction (see Section 6), not the v1 target. v1 is guided recording — a human still walks the flow once, same as today, but entirely inside TestOps instead of across three separate tools.

---

## 2. Why guided recording first, not autonomous

An autonomous agent has to know when it's stuck and stop, rather than guess and act wrong — on a login wall, an OTP screen, a payment flow, anything irreversible. Nobody has that reliably solved for mobile today. Guided recording keeps a human in the loop for exactly the moments that require judgment, while still removing every manual step around it.

---

## 3. Current state vs. target state

| Step | Today | Phoenix v1 |
|---|---|---|
| App upload | Manual, to BrowserStack | Already in TestOps |
| Device session | Manual, via BrowserStack dashboard | Already in TestOps |
| Live device view | Separate desktop app (Appium Inspector) | Embedded in TestOps |
| Recording | Appium Inspector's Record feature (WDIO output) | Captured inside TestOps, any output format |
| Script generation | Manual copy-paste from Inspector | Automatic, AI-generated, on "Stop" |
| Import into TestOps | Manual | Automatic — it's already there |

---

## 4. Architecture — Stage 0

Three components, built in this order.

### 4.1 Session & live view
- Fork `appium/appium` (core), `appium/appium-uiautomator2-driver` (Android), `appium/appium-xcuitest-driver` (iOS).
- Strip out: client SDKs, plugins not in use, Appium Inspector itself. Keep only the driver + server core.
- Get one clean session working end-to-end: launch app on an Android emulator, take a screenshot, read the accessibility tree, inject a tap. This is the Stage 0 milestone — equivalent to Strata's first lexer→parser→AST pass.
- Build the embedded live view in TestOps: poll screenshots (~300ms interval), forward tester clicks as tap commands against the same session, translating click pixel position to device coordinates.

### 4.2 Capture layer
- On every tap: log the coordinate, the resolved element (from the accessibility tree — prefer `resource-id`/`accessibility-id`, fall back to text/content-desc, then structural path, coordinates last), and a screenshot before/after.
- Store as a structured session log — this is the input to generation, and later, the input to the AI-native semantic layer in Phase 2.

### 4.3 AI generation pipeline
- Input: the captured session log.
- Output: a named, commented, parameterized script with inferred assertions (diff accessibility tree/screenshot before vs. after each step to propose what to assert).
- Runs once, on "Stop" — not live during recording (see prior discussion on why post-processing beats real-time generation: the model needs the whole flow in view to write a coherent script, not just react to isolated taps).
- Saved directly as a TestOps test case. No export/import step.

---

## 5. Devices — authoring vs. validation

- **Authoring (recording, iteration):** local/self-hosted Android emulators and iOS simulators. Fast, free, spins up in seconds — this is what makes the loop feel closer to how Playwright's local headless Chromium feels for Web.
- **Validation/execution:** BrowserStack, real devices. Keep this for final runs and CI, not for every recording session.

This split alone removes most of the friction testers feel today waiting on cloud device sessions during authoring.

---

## 6. Roadmap beyond v1

**The AI story, told as two deliberate acts — not one blurred claim.**

*Act 1 — Guided AI (v1, this repo).* A human walks the flow once, because judgment calls (an OTP screen, a payment confirmation) aren't reliably solvable by an agent yet, and a wrong guess there costs trust fast (§2). The AI is everything *around* that human judgment: locator resolution, assertion inference, an opt-in LLM pass for naming/noise-filtering. Pitch: *a human's judgment, a machine's tedium removed.*

*Act 2 — Unattended AI (Phase 2/3, below).* Same foundation, now deciding the next action itself and knowing when to stop and hand back to a human. Pitch: *same trusted foundation, now walking the flow itself.* This is the differentiator, but it earns that status by being built in the right order — proven guided first, autonomous only once that trust exists — not by being rushed alongside v1 hardening to look more impressive sooner.

**Phase 2 — AI-native semantic layer (the actual differentiator):**
- Grounded screen snapshot: merge accessibility tree + screenshot into one compact structured format an LLM reads directly — the mobile equivalent of the grounded ARIA-snapshot work already done for Web. **First cut built:** `generation/semantic-snapshot.js` (text-only for now — accessibility tree, not yet fused with the screenshot).
- Semantic action layer: `act("tap the Login button")` instead of raw locator resolution — the engine resolves against the grounded snapshot internally. **Built and wired to a live session:** `generation/semantic-act.js` resolves via the local Ollama model with a hard "unresolved rather than guess" contract; `engine/semantic-act-executor.js` takes that resolution, builds the selector with the same `pipeline.js` code the guided path uses, and actually taps/types on a live WebDriver session, refusing to act if the element vanished between snapshot and action.
- State-diff reporting: feeds the assertion-inference step directly. **First cut built:** `generation/semantic-diff.js` — not yet actually feeding `pipeline.js`'s assertion inference or a Phase 3 loop; both are still unbuilt consumers.
- Keep the standard WebDriver protocol surface working underneath, so existing recorded scripts don't break. **Holds today** — `semantic-act-executor.js` uses `driver.$(selector).click()`/`.setValue()`, the same standard WebDriver calls the guided path's `synthesizeCode` output uses; nothing in `run-session.js`/`session-manager.js`/the guided pipeline calls into any of this yet, so a running recording session is unaffected either way.

**Still open in Phase 2:** `run-semantic-action.js` is a standalone CLI entry point that calls `executeSemanticAction()` against a real session (same env-var conventions as `run-session.js`), and `POST /api/semantic-action` (`frontend/semantic-action-endpoint.js`, gated behind `PHOENIX_ENABLE_SEMANTIC_API=1`, off by default) is a first product-surface entry point that runs one instruction against whatever session a tester already has open — but **nobody has run either against real hardware yet**; both are proven only by unit tests against faked drivers. Fusing the screenshot into the grounded snapshot (still text/accessibility-tree-only) and feeding `semantic-diff.js`'s output into assertion inference are both also still open.

**Phase 3 — autonomous exploration (R&D track, not customer-facing until proven):**
- An agent that takes a goal in plain language, reads the grounded snapshot, decides the next action, executes it, and knows when to stop and hand back to a human. **First skeleton built:** `engine/semantic-loop.js`'s `runAutonomousLoop()` — decide-one-action → execute via `semantic-act-executor.js` → feed the diff back in as context → repeat, stopping on the model saying the goal is done, the model asking to stop (its own judgment-call safety valve), an action failing/being unresolved, or a hard step cap. Every stop reason is explicit and returned to the caller; nothing retries silently. Unit-tested against fakes only — **no real device run, no internal app has actually been walked by this yet.** A matching CLI, `run-semantic-loop.js` (mirrors `run-semantic-action.js`'s shape), exists so that first real run is one command away.
- Build and test this against your messiest internal apps (logins, OTP, payment flows) before it touches a real customer app. **Not started** — this is the next real step, and it needs `run-semantic-action.js`'s single-action real-hardware proof to land first before a multi-step loop is worth trusting on a device at all.

---

## 7. Open decisions before engineering starts

- Which Android/iOS versions does Stage 0 need to support on day one, or is single-version-first acceptable?
- Self-hosted emulator infrastructure: existing team capacity, or new infra to provision?
- Team size and who owns the fork vs. the AI pipeline vs. the TestOps embedding work — three fairly distinct skill sets.

---

*This is a starting spec, not a finished one — meant to hand to engineering as the basis for sprint planning, not as final architecture.*
