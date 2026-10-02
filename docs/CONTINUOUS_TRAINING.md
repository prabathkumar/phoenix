# Continuous training — how execution logs actually improve the model

Explicit direction from the user: manual log-reading to diagnose and fix
the resolver (the loop that closed `test-cases/addons.json`'s 18 bugs by
hand, one run at a time) has to become automatic — every execution should
feed back into the model, wired into the semantic layer itself, with
nothing manual. This doc is the honest version of that: what's fully
automatic today, what the frothAI hardware (ARM, CPU-only, 32GB RAM)
actually allows, and the realistic pipeline given that.

## 1. Automatic capture — done, wired into the semantic layer

`generation/execution-log.js`, called from every `executeSemanticAction()`
call in `engine/semantic-act-executor.js` (not a wrapper script, not
opt-in — every tap/type/scroll/tapIfExists through the semantic layer logs
itself). Zero manual step: no one has to remember to log anything, no one
pastes a log into a chat for this part anymore.

Each line in `training-data/executions.jsonl` (JSONL — one JSON object per
line, trivial to append to or stream) records: the instruction, the kind,
whether a cached selector was used, the resolved selector, the resulting
diff summary, success/failure and why, and which code path produced the
result (fresh resolution, cache replay, self-heal, a `tapIfExists` skip).

**Credential safety, non-negotiable:** a "type" step's `options.text` is,
after substitution, a real value — a real phone number or password. The
logger never writes that value, only whether one was given and its length
(`hadText`, `textLength`). This is covered by a dedicated test
(`generation/test/execution-log.test.js`) that asserts the real string
never appears in the serialized record, the same bar
`mergeResolvedSelectors` already holds selector caching to.

**Moving the data onto the Ollama host is exactly as simple as described:**
it's flat JSONL files, so a periodic `rsync`/`scp`/shared-volume copy is
enough — no special pipeline needed for the "push" step itself. The part
that isn't instant is what happens after the file lands.

## 2. What "training" can mean on this hardware, and which one is honest

Two different things both get called "training," and they have very
different costs on ARM/CPU-only/32GB RAM:

**(a) Actually changing the model's weights (fine-tuning).** This needs a
training toolchain (not Ollama itself — Ollama serves GGUF models, it
doesn't fine-tune them) and runs that update millions-to-billions of
parameters against the collected examples. On a GPU this can take minutes
to hours depending on data volume; on CPU-only ARM hardware at this scale,
even a lightweight LoRA fine-tune of a 7B-class model realistically runs
in **hours to days**, not something that happens "instantly" per
execution or even practically on a nightly cadence. Doing this
automatically and unreviewed, after every run, also risks silently
degrading the model with nobody checking — directly against this whole
codebase's "never guess, always verify" discipline (the exact lesson of
`docs/STATUS.md`'s false-success bugs #16/#18). If this is wanted, the
honest shape is: accumulate data → run a fine-tune job much less
frequently (weekly/monthly, or triggered manually when enough new
corrections have piled up) on a machine that actually has GPU access →
automatically replay the full regression set (every bug this repo has
ever closed — `test-cases/addons.json`'s 18, `login.json`'s, the loop's
nine) against the candidate model → only promote it to the model tag
`PHOENIX_OLLAMA_MODEL` points at if the regression set still passes.
That gate is itself automatable (a pass/fail script, not a human), so
"nothing manual" still holds for this path — it's just not *instant*.

**(b) Feeding corrections back into what the model sees, without
retraining it at all.** This works entirely on CPU-only inference,
today, with no GPU and no training job — because nothing about the
model changes, only what's included in the prompt `generation/semantic-act.js`
already sends to it. Two pieces of this already exist and are fully
automatic:
  - **Positive replay (already shipped):** `resolvedSelector` caching
    (`engine/test-case-runner.js`, `mergeResolvedSelectors`) means a
    step that resolved correctly once never asks the model again for
    the same instruction on the same step — the "answer" is replayed
    directly. This already closes the most common case automatically,
    with zero manual edits (confirmed end-to-end on `addons-run-android-16.log`:
    the login sequence and the Add-ons-tap step both carry
    model-learned selectors written back to the test-case file by the
    framework itself, not by hand).
  - **Negative exclusion within one run (already shipped):** the
    self-heal retry (`engine/semantic-act-executor.js`,
    `resolveSemanticAction`'s `excludedRefs`) excludes an element that
    just proved to be a dead tap from the very next resolution attempt,
    live, in the same run.

**What's new and still worth building** from (b): extending negative
exclusion *across* runs, not just within one — if a resolved selector is
later found to be a dead-end or a wrong-but-functional click (once an
outcome-verification signal exists to detect that second case), record
it the same way `resolvedSelector` is recorded today, and exclude it from
candidates on every future run for that step. This is genuinely
"learning from every execution" and runs instantly on CPU-only hardware,
because it's a filter on what's offered to the model, not a change to the
model itself. Flagged here as the next concrete increment, not yet built
in this pass — it needs the outcome-verification signal (the still-open
false-success gap) to be meaningful for the wrong-but-functional-click
class; for the already-solved dead-tap class, it's a direct extension of
the existing in-run `excludedRefs` mechanism to a persisted field.

## 3. Recommendation, stated plainly

Given the actual hardware: build and lean on (b) — it's automatic, it's
instant, and it runs today on the ARM box with no GPU and no training
job. Treat (a) as a real but separate, periodic, GPU-dependent process
with its own automatic regression gate, not something wired into the
live per-execution path. Both start from the same automatically-captured
`training-data/executions.jsonl` this pass just wired in — nothing about
collecting that data waits on which path gets built next.
