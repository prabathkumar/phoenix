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
