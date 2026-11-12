# The approach: one ladder, honest reporting

Kept from the TestOps ai-automate architecture. Every fix to execution follows it.

## The ladder

Four layers, tried in order. Each step is stored once, in one test-case format.

| Layer | What it is | Calls a model? |
|---|---|---|
| Synthetic | The recorded locator and generated script, replayed. Runs first, every time. | Never |
| Semantic (with vision, opt-in) | A plain-language instruction picks one element from the page's element list. It declines rather than guesses. | Yes |
| AI | A goal loop: look, pick one action, check what changed, repeat. Stops for a person before anything irreversible. | Yes |
| Guided | A person retries, scrolls, gives a locator, or skips. The last rung. | No |

**Falling down:** when a step cannot be done it moves one rung down, and each rung is told what failed (the dead locator, the page change, earlier failures in the run). If nothing rescues it, the failure lists every rung tried. There is no silent "not found".

**Promoting up:** a rescue proposes a patch for the Synthetic layer. A patch needs evidence (the expectation passed, the page changed, a value was typed). Fragile locators are never promoted. A patch is applied only on request, never silently.

## Honest reporting

"Succeeded" means no step errored. Each result says how every step was resolved (`resolvedBy`), which steps needed a rescue, and any warnings (for example, recorded on Android, ran on iOS). An unresolved step is reported as unresolved, never as a guess.

## Test data

Generate what can be made up, ask only for what cannot (logins, existing ids, OTPs, tokens). Only fields a step names as `${NAME}` are sent to the engine. Values never reach the model and are never stored in results.

## Where this lives in the platform

| Principle | Where |
|---|---|
| The ladder | `web/web-ladder.js`, `web/web-test-case-runner.js` (Node engine) |
| Per-step `resolvedBy`, rungs tried, rescues, warnings in every case result | `frontend/exec-endpoint.js` -> stored on each execution -> shown on the run result page |
| Test data layer | `backend/phoenix_api/testdata.py` (plan from `${NAME}` references) |
| Guided / needs-you at every gate | `backend/phoenix_api/ai_pipeline.py` (approval gates) |
| A scenario is run whole; a partial suite is deliberate and shown | `service.py` execution stage, `signoff.py` release checks |
| One model door | `backend/phoenix_api/gateway.py` |

## Still open

Mobile ladder rungs wait on the Appium surface adapter. Web Semantic and AI are proven only against scripted models, not a real model on a real site. Nothing here has run against a real BrowserStack device.
