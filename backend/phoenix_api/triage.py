"""The model reads the failed tests and their logs, says what each failure is, and picks which to run again.
verdicts: flaky (timing / ordering / hash order) | environment (network, tool, permission, missing service) | test_bug | code_bug.
Only flaky and environment failures are re-run. The re-run is the proof: it checks the model's call, and the pair (logs -> verdict, outcome) is stored as a training example
(opt-in capture, masked, see logstore), so the 8B model learns from real failures. A person still decides what a code_bug means: the model never edits code here."""
import json

VERDICTS = ("flaky", "environment", "test_bug", "code_bug")
PROMPT = (
    "You are a test triage engineer. Below are failed tests with the tail of the run log. For EACH failed test decide: "
    "flaky (timing, ordering, hash order, race), environment (network, missing tool or service, permission, disk), test_bug (the test itself is wrong), or code_bug (the code under test is wrong). "
    'Answer JSON only: {"failures":[{"name":"<exact test name>","verdict":"flaky|environment|test_bug|code_bug","rerun":true|false,"reason":"<one short sentence>"}]}. '
    "Set rerun true only for flaky or environment."
)


async def triage(failures, log, call_json):
    """failures: [{language, kind, name}], log: text. Returns {name: {verdict, rerun, reason}} (empty if the model gave nothing usable)."""
    if not call_json or not failures:
        return {}
    body = "FAILED TESTS:\n" + "\n".join(f"- {f['name']} ({f['language']} {f['kind']})" for f in failures[:40]) + f"\n\nLOG TAIL:\n{(log or '')[-3000:]}"
    try:
        r = await call_json(f"{PROMPT}\n\n{body}")
    except Exception:  # noqa: BLE001 - triage is a helper, never a reason to fail the run
        return {}
    items = r.get("failures") if isinstance(r, dict) else r
    out = {}
    for it in items if isinstance(items, list) else []:
        if isinstance(it, dict) and it.get("name") and it.get("verdict") in VERDICTS:
            out[str(it["name"])] = {"verdict": it["verdict"], "rerun": bool(it.get("rerun")) and it["verdict"] in ("flaky", "environment"), "reason": str(it.get("reason", ""))[:200]}
    return out


def example(project, failure, log, call, actual):
    """One training example. outcome verified when the re-run agreed with the model, corrected (with the better answer) when it did not."""
    agreed = (call["verdict"] in ("flaky", "environment")) == (actual == "passed") if call["rerun"] else call["verdict"] in ("code_bug", "test_bug")
    ans = json.dumps(call)
    fixed = {"verdict": "flaky" if actual == "passed" else "code_bug", "rerun": actual == "passed"}
    return {"project": project, "source": "triage", "prompt": f"{failure['name']} ({failure['language']} {failure['kind']})\n{(log or '')[-1500:]}", "response": ans,
            "outcome": "verified" if agreed else "corrected", "preferred": "" if agreed else json.dumps(fixed)}


async def triage_and_rerun(results, root, call_json, project, kw, record=None):
    """The model reads each failing run's log, picks the flaky/environment failures, and they are run again (results are updated in place).
    record(kind, row) stores each call and its proof as a training example (opt-in capture, see logstore)."""
    from . import test_connectors as tcx
    for r in results:
        fails = [{"language": r["language"], "kind": r["kind"], "name": t["name"]} for t in r["tests"] if t["status"] == "failed"]
        if not fails:
            continue
        calls = await triage(fails, r.get("log", ""), call_json)
        r["triage"] = [{"name": n, **c} for n, c in calls.items()]
        again = [f for f in fails if calls.get(f["name"], {}).get("rerun")]
        if not again:
            continue
        r2 = tcx.run_tests(r["language"], r["kind"], root, retry=False, **kw)
        after = {t["name"]: t["status"] for t in r2["tests"]}
        for t in r["tests"]:
            if t["name"] in {f["name"] for f in again} and after.get(t["name"]) == "passed":
                t["status"], t["flaky"] = "passed", True
        r["summary"] = tcx.summarize(r["tests"])
        r["ok"] = r["summary"]["failed"] == 0
        r["detail"] += f" (model re-ran {len(again)} failure(s); {sum(1 for f in again if after.get(f['name']) == 'passed')} passed the second time)"
        for f in again:
            if record:
                record("training_example", example(project, f, r.get("log", ""), calls[f["name"]], after.get(f["name"], "failed")))
