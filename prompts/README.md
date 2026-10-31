# FrothTestOps prompt registry

One file (`prompts.yaml`) holds every LLM system prompt for test design (scenarios, cases)
and automation (Playwright web + Phoenix mobile). Python and Node load the same file.

## Install
1. Copy this `prompts/` folder to `frothtestops-backend--2.0/prompts/`.
2. Python: `pip install pyyaml` (if not already installed).
3. Node: in `phoenix_engine/` run `npm install js-yaml`.

## Use
Python (Django/Celery):
```python
from prompts.registry import get_prompt
system_prompt, prompt_id = get_prompt("testcase_target")
logger.info("[LLM] prompt_id=%s", prompt_id)
```
Node (phoenix_engine):
```js
const { getPrompt } = require("../../prompts/registry");
const { text: system, id } = getPrompt("element_resolver", "mobile");
console.error(`[llm] prompt_id=${id}`);
```

## Prompt map (replace the old hardcoded constants)
| Registry name | Platform | Replaces |
|---|---|---|
| `scenario_single` | shared | `SCENARIO_SINGLE_SYSTEM_PROMPT` |
| `scenario_batch` | shared | `SCENARIO_SYSTEM_PROMPT` |
| `scenario_stream` | shared | `SCENARIO_STREAM_SYSTEM_PROMPT` |
| `case_coverage` | shared | `SCENARIO_CASE_COVERAGE_SYSTEM_PROMPT` |
| `testcase_target` | shared | `TESTCASE_SINGLE_TARGET_SYSTEM_PROMPT` |
| `step_normalizer` | web / mobile | "You are a QA test-step normalizer..." |
| `element_resolver` | web | "You are the element-resolution engine of a web test-automation tool..." |
| `element_resolver` | mobile | Phoenix "You are resolving a natural-language mobile test instruction..." |
| `script_assembler` | web | "You are an expert Playwright test automation engineer..." |

The Phoenix resolver's per-step part (instruction, past successes/failures, retry note,
snapshot) stays in code as the USER message - it changes on every call.

Output formats are unchanged per platform (web resolver `{"idx": ...}`, mobile resolver
`{"ref": ...}`), so existing parsers keep working. The mobile resolver's decline reason now
starts with `NOT_ON_SCREEN:`, `AMBIGUOUS:` or `NO_MATCH:` - parse it to scroll-and-retry on
`NOT_ON_SCREEN`.

## Change a prompt
1. Edit the block in `prompts.yaml`.
2. Bump `version` (e.g. `2026.10.29-2`).
3. Commit. Both loaders hot-reload - no restart needed.
4. Check logs: `prompt_id` shows name, platform, version and a content hash.

## A/B test a variant
Add e.g. `mobile_v2: [...]` under a prompt and call `get_prompt("element_resolver", "mobile_v2")`.

## Companion code changes (needed for full effect)
- Pass `ALREADY ACCEPTED CASES:` for the WHOLE requirement into `testcase_target` calls, and make
  the dedupe check compare across all scenarios, not only the current one.
- Disable the separate `case_classify_batch` call (classification is now in `testcase_target`).
- Send Verify steps through the element resolver so they arrive with a locator.
- Mobile: on `NOT_ON_SCREEN`, scroll and retry before failing; keep resolver `max_tokens` ~80;
  skip screenshots unless a vision model is configured.
