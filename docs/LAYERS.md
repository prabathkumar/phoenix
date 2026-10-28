# The four layers: Guided, Synthetic, Semantic, AI

TestOps ai-automate is one framework with one recorder page and one test-case format.
How a step gets done is described by four layers that are wired together as a ladder.

| Layer | What it is | When it acts |
|---|---|---|
| **Guided** | The tester drives: clicks, types, picks a dropdown value, adds an API check. Also the last rung when everything else fails. | Recording; and whenever the machine layers cannot finish a step. |
| **Synthetic** | The generated, replayable script / test case: recorded locators, parameters, expectations. Deterministic, no model. | Every replay, first. |
| **Semantic** | Plain-language instruction to element ("click Sign in"), with a **vision** add-on (a screenshot goes to the model with the element list). Never guesses: unsure means decline. | When a recorded locator fails, or a step has no locator. |
| **AI** | A goal loop: look, choose one action, act, check what changed, repeat. | When Semantic cannot resolve the step and AI is switched on (`--ai`, or "Ask AI" while recording). |

## The ladder runs both ways

**Falling down.** A Synthetic step whose locator is dead (or cannot be acted on) falls to
Semantic; if Semantic declines, to AI (if enabled); if that fails, to Guided (a person is asked).
Each rung is told what failed: the dead locator, the page diff since the last step, and the
failures already seen in this run. If nothing rescues the step, the failure message lists every
rung that was tried.

**Promoting back up.** Every rescue returns a **patch** describing how to move the fix up into
the Synthetic layer: Semantic proposes a new locator, AI proposes new steps, Guided proposes the
locator the person gave. Patches are proposals gated on evidence (the step's expectation passed,
or the page visibly changed, or a value was typed), and fragile locators are never promotable.
Nothing is written silently: replay prints them, and `--persist` applies only the promotable ones.
The next run then passes on the Synthetic layer alone.

Every step in a run reports `resolvedBy` (`synthetic | semantic | ai | guided`) and the result
carries a tally, so the health of a suite is visible at a glance: a suite that is mostly
`semantic` is drifting and needs its patches promoted.

## Safety rails
- The AI loop has a step budget, detects "same action, nothing changed", refuses to leave the
  start site, and stops for a person before anything that looks irreversible (pay, delete, ...).
- Semantic and AI only choose from elements actually on the page (by ref); a wrong or
  disabled pick is rejected, and a pick contradicting the step's expectation is retried without it.
- Credentials are never persisted as typed values; `${NAME}` placeholders stay placeholders.

## One surface, two engines
The Semantic resolver, the goal loop and the ladder are written once against a `Surface`
(`engine/core/surface.js`): snapshot, screenshot, lines, perform, selectorFor. Playwright has an
adapter today (`web/surface/`). Appium gets the same adapter later, migrated behind tests rather
than rewritten blind, because the existing Appium code is hardware-proven. Until then the mobile
path keeps its own Semantic/AI implementation (`generation/semantic-act.js`,
`engine/semantic-loop.js`) and the mobile ladder rungs AI/Guided on Appium are not yet unified.

## Using it
```bash
# replay with the ladder (Semantic always on when a locator fails)
node web/run-web-test-case.js flow.json --headed
# also allow the AI loop, and ask you at the terminal as a last resort
node web/run-web-test-case.js flow.json --ai --ask
# apply the evidence-backed fixes into the file
node web/run-web-test-case.js flow.json --persist
# let the AI layer do a goal from scratch and save what it did
node web/run-web-loop.js "sign in and open the dashboard" --url https://example.com --out flow.json
```
Semantic and AI need the local model (Ollama, see `docs/SETUP.md`). Add `--no-vision` for text-only.

## API steps and test data (any layer, web or mobile)
An `api` step calls an endpoint from inside the flow (for example to confirm the database changed):
method, URL, headers, body, checks (status, JSON path equals/contains/exists/matches, bodyContains,
maxMs) and `save` values that later steps use as `${NAME}`. In the recorder: **Add API check**
runs it live, shows the response, and records it. Test data is a set of named values the tester
brings on the start screen; typing one records a named parameter (`USERNAME`), not `field_3`.

See also: [Test data layer](TEST_DATA.md), which fills `${NAME}` values before a run (generate, upload, or ask only for what cannot be made up).
