"""One AI-driven pipeline: scenarios -> cases -> test data -> execution -> HAR -> performance -> secrets -> SAST -> DeepEval -> traceability ->
API functional tests -> repo link -> unit tests -> PR -> deployment check -> DAST -> defects -> feedback -> confirm. Each stage reports passed | failed | needs-you | skipped | not-built | unavailable.
Autonomy: ask-everything | ask-when-matters (default) | run-everything. A live security scan (dast) and anything aimed at production always wait for approval.
A handler is `async (ctx) -> {ok, detail, data?, unavailable?}`. 'not-built' is stated plainly; nothing is faked as passed."""
import asyncio
import os
import subprocess
import time

from . import testdata as td, unit_tests

STAGES = [
    # 1. the AI writes test cases and asks for each layer: API, web, mobile, performance
    {"id": "scenarios", "name": "Test scenarios (prompts)", "needs": []},
    {"id": "cases", "name": "Test cases (prompts)", "needs": ["scenarios"]},
    {"id": "testdata", "name": "Test data", "needs": ["cases"]},
    {"id": "apitests", "name": "API functional tests (built from the API layer, run by the agent)", "needs": []},
    {"id": "execution", "name": "Web and mobile test execution (local or BrowserStack)", "needs": ["testdata"]},
    {"id": "har", "name": "HAR capture", "needs": ["execution"]},
    {"id": "performance", "name": "Performance (Locust)", "needs": ["cases"]},
    # 2. the code repo is linked: languages found, then secrets, Semgrep, unit tests, unit integration tests
    {"id": "repolink", "name": "Code repo linked: languages and API calls found", "needs": []},
    {"id": "secrets", "name": "Secrets scan (Gitleaks)", "needs": []},
    {"id": "sast", "name": "SAST (Semgrep, source code)", "needs": []},
    {"id": "aieval", "name": "AI answer quality (DeepEval)", "needs": []},
    {"id": "traceability", "name": "Requirements vs what is built (repo)", "needs": []},
    {"id": "unittests", "name": "Unit and API integration tests written by the AI (many languages)", "needs": []},
    {"id": "unitrun", "name": "Unit and integration tests run (language by language)", "needs": []},
    {"id": "revalidate", "name": "Flaky, functional and negative checks repeated by the agents (AI-written tests, synthetic data)", "needs": []},
    {"id": "testspr", "name": "Pull/merge request with the tests (GitHub or GitLab)", "needs": ["unittests"]},
    # 3. after the deployment: is the app up, then the security test
    {"id": "deployed", "name": "Deployment check: the app answers", "needs": []},
    {"id": "dast", "name": "Security test after deployment (ZAP, running app)", "needs": ["deployed"]},
    {"id": "defects", "name": "Defects to Jira", "needs": ["execution"], "always": True},
    {"id": "signoff", "name": "Sign-off request (test cases and run)", "needs": [], "always": True},
    {"id": "feedback", "name": "Logs, data and reports back to the AI", "needs": [], "always": True},
    {"id": "measure", "name": "Measure: KPIs and TMMI view from the logs", "needs": [], "always": True},
    {"id": "evidence", "name": "Evidence: reports and screenshots packed, checked, and given to the AI", "needs": [], "always": True},
    # 4. last: confirm that everything that was asked for works
    {"id": "confirm", "name": "Confirm: every step that was asked for is working", "needs": [], "always": True},
]
RISKY = {"defects", "testspr"}
ALWAYS_ASK = {"dast"}
TOUCHES_APP = {"execution", "har", "performance", "dast", "apitests", "deployed"}
REASON = {"production": "it is aimed at production, which always needs your approval",
          "always": "it sends attack traffic to a live app, which always needs your approval",
          "level": "waiting for your approval at the autonomy level you chose"}


def must_ask(stage_id, autonomy="ask-when-matters", approvals=None, production=False):
    if production and stage_id in TOUCHES_APP:
        return "production"  # asks every time, even when approved
    if (approvals or {}).get(stage_id):
        return None
    if stage_id in ALWAYS_ASK:
        return "always"
    if autonomy == "ask-everything":
        return "level"
    if autonomy == "ask-when-matters" and stage_id in RISKY:
        return "level"
    return None


def _has(cmd, run):
    try:
        return run([cmd, "--version"], capture_output=True, text=True, timeout=30).returncode == 0
    except Exception:
        return False


def _default_run(cmd, **kw):
    return subprocess.run(cmd, **{"capture_output": True, "text": True, "timeout": 600, **kw})


def builtins(run=_default_run):
    def scan(cmd, args, label, parse=None):
        async def h(ctx):
            env = ctx.get("env") if isinstance(ctx.get("env"), dict) else os.environ
            if env.get("PHOENIX_TOOL_MODE") == "container" and _has("docker", run):   # the tool runs in its own pinned container, never on this machine
                from . import toolhub
                d = os.path.realpath(ctx.get("dir") or ".")
                argv = toolhub.docker_argv(toolhub.image_ref(cmd, env), ([cmd] if cmd == "semgrep" else []) + args("/src", ctx), mount=d)
                r = await asyncio.to_thread(run, argv)
                out = r.stdout or ""
                return {"ok": r.returncode == 0, "detail": f"{label} (container): no findings" if r.returncode == 0 else f"{label} (container): findings or error (exit {r.returncode})",
                        "data": {"stdout": out[:4000], **(parse(out) if parse else {})}}
            if not _has(cmd, run):
                return {"unavailable": True, "detail": f"{cmd} is not installed on this machine"}
            r = await asyncio.to_thread(run, [cmd, *args(ctx.get("dir") or ".", ctx)])
            out = r.stdout or ""
            return {"ok": r.returncode == 0, "detail": f"{label}: no findings" if r.returncode == 0 else f"{label}: findings or error (exit {r.returncode})",
                    "data": {"stdout": out[:4000], **(parse(out) if parse else {})}}
        return h

    async def testdata(ctx):
        names = td.required_names(ctx.get("steps") or [])
        plan = td.plan_test_data(names, ctx.get("testData") or {}, ctx.get("seed") or "pipeline", ctx.get("env"))
        if plan["needs_you"]:
            return {"ok": False, "detail": f"needs you: {', '.join(plan['needs_you'])}", "data": {"names": names, "needsYou": plan["needs_you"]}}
        return {"ok": True, "detail": f"{len(plan['fields'])} field(s) ready", "data": {"names": names}}

    async def confirm(ctx):
        """Every stage that was asked for must have PASSED. Skipped stages are listed (not counted). Unavailable, not-built, failed and waiting stages are NOT working, and are named."""
        rows = [x for x in ctx.get("results", []) if x["id"] != "confirm"]
        asked = [x for x in rows if x["status"] != "skipped"]
        bad = [x for x in asked if x["status"] != "passed"]
        left = [x["id"] for x in rows if x["status"] == "skipped"]
        data = {"asked": len(asked), "working": len(asked) - len(bad), "notWorking": [{"id": x["id"], "status": x["status"], "detail": x.get("detail", "")[:160]} for x in bad], "notAsked": left}
        if not asked:
            return {"ok": False, "detail": "nothing was run, so nothing is confirmed", "data": data}
        return {"ok": not bad, "detail": f"all {len(asked)} step(s) asked for are working" if not bad else f"{len(bad)} of {len(asked)} step(s) are not working: " + ", ".join(f"{x['id']} ({x['status']})" for x in bad), "data": data}

    return {
        "confirm": confirm,
        "testdata": testdata,
        "secrets": scan("gitleaks", lambda d, c: ["detect", "--no-git", "-s", d, "--redact"], "gitleaks"),
        "sast": scan("semgrep", lambda d, c: ["--config", "p/security-audit" if c.get("ruleset") == "security-audit" else "auto", "--json", "--error", "--quiet", d], "semgrep",
                     lambda out: {"findings": unit_tests.parse_semgrep(out)}),
    }


async def run_pipeline(ctx=None, handlers=None, only=None, run=_default_run, ai=None, autonomy=None, approvals=None, production=False):
    ctx = ctx or {}
    gate = {"autonomy": autonomy or "ask-when-matters", "approvals": approvals or {}, "production": bool(production or ctx.get("production"))}
    allh = {**builtins(run), **(handlers or {})}
    done, stages = {}, []
    for st in STAGES:
        sid = st["id"]
        if only is not None and sid not in only:
            done[sid] = "skipped"
            stages.append({"id": sid, "name": st["name"], "status": "skipped", "detail": "not selected"})
            continue
        blocked = next((n for n in st["needs"] if done.get(n) in ("failed", "blocked")), None)
        if blocked and not st.get("always"):
            done[sid] = "blocked"
            stages.append({"id": sid, "name": st["name"], "status": "skipped", "detail": f"waiting on {blocked}"})
            continue
        ask = must_ask(sid, **gate)
        if ask and sid in allh:
            done[sid] = "blocked"
            stages.append({"id": sid, "name": st["name"], "status": "needs-you", "detail": REASON[ask], "approve": sid})
            continue
        h = allh.get(sid)
        if not h:
            done[sid] = "not-built"
            stages.append({"id": sid, "name": st["name"], "status": "not-built", "detail": "no handler yet"})
            continue
        t0 = time.time()
        try:
            r = (await h({**ctx, "results": stages})) or {}
            status = "unavailable" if r.get("unavailable") else "passed" if r.get("ok") else "failed"
            done[sid] = "failed" if status == "failed" else "ok"
            stages.append({"id": sid, "name": st["name"], "status": status, "detail": r.get("detail", ""), **({"data": r["data"]} if r.get("data") else {}), "ms": int((time.time() - t0) * 1000)})
        except Exception as e:
            done[sid] = "failed"
            stages.append({"id": sid, "name": st["name"], "status": "failed", "detail": str(e), "ms": int((time.time() - t0) * 1000)})
    if ai:  # the model reads each stage's outcome (never its data) and writes a note; a failing model never fails the run
        brief = [{"id": s["id"], "status": s["status"], "detail": s.get("detail", "")} for s in stages]
        for st in stages:
            if st["status"] == "skipped":
                continue
            try:
                r = await ai({"stage": {"id": st["id"], "status": st["status"], "detail": st.get("detail", "")}, "pipeline": brief})
                if r and r.get("note"):
                    st["ai"] = str(r["note"])
            except Exception as e:
                st["ai"] = f"AI review unavailable: {e}"
    count = lambda s: sum(x["status"] == s for x in stages)  # noqa: E731
    summary = {"needsYou": count("needs-you"), "passed": count("passed"), "failed": count("failed"), "skipped": count("skipped"), "notBuilt": count("not-built"), "unavailable": count("unavailable")}
    return {"ok": summary["failed"] == 0 and summary["needsYou"] == 0, "stages": stages, "summary": summary, "needsYou": [x["approve"] for x in stages if x["status"] == "needs-you"]}


def llm_reviewer(call_json):
    async def review(a):
        s = a["stage"]
        return await call_json(f'You are the QA pipeline\'s reviewer. Stage "{s["id"]}" ended "{s["status"]}": {s["detail"]}\nWhole run: {a["pipeline"]}\nReply JSON {{"note":"one or two sentences: the likely cause and the next action"}}.')
    return review
