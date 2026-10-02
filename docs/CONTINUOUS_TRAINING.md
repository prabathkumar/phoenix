# Continuous training — how execution logs actually improve the model

Explicit direction from the user: manual log-reading to diagnose and fix
the resolver (the loop that closed `test-cases/addons.json`'s 18 bugs by
hand, one run at a time) has to become automatic — every execution should
feed back into the model, wired into the semantic layer itself, with
nothing manual. This doc is the honest version of that: what's fully
automatic today, what the frothAI hardware (ARM, CPU-only, 32GB RAM)
actually allows, and the realistic pipeline given that.

## 0. Retention — old records are pruned automatically too

Once a training cycle (periodic fine-tune, or just the prompt-level
feedback in §2(b) below) has consumed a batch of logged executions, the
log itself doesn't need to be kept around indefinitely. `logExecution()`
automatically prunes records older than `PHOENIX_TRAINING_LOG_RETENTION_DAYS`
(default **15 days**) every time it's called — cheaply, via a sentinel
file next to the log that tracks when cleanup last ran, so the real cost
(rewriting the file) only happens roughly once per retention window, not
on every single execution. No separate cron job, no manual "go delete the
old logs" step — as long as Phoenix is being run at all, the log stays
bounded on its own. `pruneOldExecutions()` is also exported directly for
an on-demand or externally-scheduled cleanup if a deployment prefers that
instead.

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

**Cross-run negative exclusion for the dead-tap class — done.** The
in-run-only `excludedRefs` self-heal described above now persists: when
`engine/semantic-act-executor.js`'s self-heal retry succeeds, the
ORIGINAL dead-end selector is captured separately (`deadSelector`, kept
distinct from the healed, working `selector` that replaced it) so
`generation/execution-log.js` can log what was actually proven dead, not
just the good outcome that followed it. `getDeadSelectors(instruction)`
reads that history back — both a healed run's `deadSelector` and a
never-healed run's own `selector` (when its only outcome was "No visible
change.") — and `generation/semantic-act.js`'s `resolveSemanticAction()`
automatically excludes any live element matching one of those exact
resource-id/accessibility-id/text values from the candidate list, before
the model ever sees it, on every future run of that exact instruction.
Deliberately a **hard** exclusion (unlike `getPastFailures()`'s soft
hint above) — see `getDeadSelectors()`'s own doc comment for why that's
safe here: a dead tap is a concrete, already-observed fact about one
specific control, not a judgment call about whether an instruction was
understood, so there's no real risk of permanently blinding the resolver
to a legitimate match the way hard-excluding a *failure* might. Scoped
to `kind: "tap"` and exact-instruction matches only, matching the in-run
mechanism it extends. Covered by dedicated tests in
`generation/test/execution-log.test.js` (the log read/write shape) and
`generation/test/semantic-act.test.js` (the exclusion actually keeping
the dead element out of the prompt, scoped correctly by kind and
instruction).

**Closed:** the wrong-but-functional-click class (a tap that *does*
visibly change the screen, just not the way the instruction meant —
`docs/STATUS.md` bugs #13–#18) now has cross-run memory too, alongside
the dead-tap (no-op) case `getDeadSelectors()` already closed. One
subset was closed first: a tap that hits the *correct* element but
whose declared `expect` outcome hadn't rendered YET (a slow network
load, not a wrong click) no longer gets misreported as a failure —
`engine/semantic-act-executor.js`'s outcome-settle retry (see
`docs/STATUS.md`'s Add-ons-tap writeup) polls past that race before
judging. The remaining, genuinely *wrong*-click case is now closed too:
`engine/test-case-runner.js`'s `runScriptSteps()` is the one place that
both knows a step declared an `expect` and has already made the final,
post-settle-retry `verifyExpectedOutcome()` call — when that call fails
on a tap that produced a REAL, non-empty diff (so it's not a dead tap —
something genuinely happened, just not the declared outcome), it logs
an execution record with `expectFailed: true` and the selector that was
actually tapped. `generation/execution-log.js`'s new
`getExpectFailedSelectors(instruction)` reads those back (same
dedup/limit/most-recent-first shape as `getDeadSelectors()`), and
`generation/semantic-act.js`'s `resolveSemanticAction()` removes any
matching candidate from the list before the model ever sees it,
exactly alongside the existing `deadRefs` exclusion — a `tap` whose
declared outcome has already, concretely proven wrong on a prior run of
the exact same instruction is excluded the same way a no-op tap is,
for the same reason: a proven fact about a specific control, not a
judgment call. Covered by `generation/test/execution-log.test.js`,
`generation/test/semantic-act.test.js`, and
`engine/test/test-case-runner.test.js`.

## 3. Recommendation, stated plainly

Given the actual hardware: build and lean on (b) — it's automatic, it's
instant, and it runs today on the ARM box with no GPU and no training
job. Treat (a) as a real but separate, periodic, GPU-dependent process
with its own automatic regression gate, not something wired into the
live per-execution path. Both start from the same automatically-captured
`training-data/executions.jsonl` this pass just wired in — nothing about
collecting that data waits on which path gets built next.
