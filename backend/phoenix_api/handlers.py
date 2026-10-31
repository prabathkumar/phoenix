"""The pipeline's stage handlers: what Phoenix does itself. Each says `unavailable` plainly when its tool or model is missing; none pretends to pass."""
import asyncio
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx

from . import ai_eval, jira as J, prompt_store, signoff, traceability, unit_tests
from . import http as _http


def _run(cmd, **kw):
    return subprocess.run(cmd, **{"capture_output": True, "text": True, "timeout": 900, **kw})


def _has(cmd, run=_run):
    try:
        return run([cmd, "--version"]).returncode == 0
    except Exception:
        return False


def library_prompt(name, platform="shared", env=None):
    try:
        return prompt_store.get_prompt(name, platform, env=env)
    except ValueError as e:
        raise RuntimeError(f'not configured: prompt "{name}" is not in the prompt library ({e})')


# ---- scenarios and cases (AI)
def ai_handler(prompt_name, call_json, get_prompt, user_of, platform="shared"):
    async def h(ctx):
        if not call_json:
            return {"unavailable": True, "detail": "no model configured"}
        try:
            p = get_prompt(prompt_name, platform)
        except Exception as e:
            return {"unavailable": True, "detail": str(e)[:200]}
        try:
            r = await call_json(f"{p['text']}\n\n{user_of(ctx)}")
        except Exception as e:
            if re.search(r"No model answered|not configured", str(e), re.I):
                return {"unavailable": True, "detail": f"no model reachable: {str(e)[:160]}"}
            raise
        items = r if isinstance(r, list) else next((r[k] for k in ("scenarios", "cases", "items") if isinstance(r, dict) and isinstance(r.get(k), list)), None)
        if not items:
            return {"ok": False, "detail": f"the model returned nothing usable ({p['id']})"}
        return {"ok": True, "detail": f"{len(items)} from {p['id']}", "data": {"items": items}}
    return h


def scenarios_handler(call_json, get_prompt):
    return ai_handler("scenario_batch", call_json, get_prompt, lambda c: f"REQUIREMENT:\n{str(c.get('requirement') or '')[:6000]}")


def cases_handler(call_json, get_prompt, project="", requirement_key="", run_id="", url=None):
    def user_of(c):
        sc = next((s for s in c.get("results", []) if s["id"] == "scenarios"), {}).get("data") or {}
        return f"REQUIREMENT:\n{str(c.get('requirement') or '')[:3000]}\nSCENARIOS:\n{json.dumps(sc.get('items', []))[:4000]}"
    inner = ai_handler("testcase_target", call_json, get_prompt, user_of)

    async def h(ctx):
        r = await inner(ctx)
        if r.get("ok"):  # keep them: people sign off these cases, in Postgres
            suffix = run_id[-6:] if run_id else "000000"
            for n, it in enumerate(r["data"]["items"], 1):
                d = it if isinstance(it, dict) else {"title": str(it)}
                steps = d.get("steps") or d.get("instructions") or []
                signoff.upsert_case(str(d.get("id") or f"TC-{suffix}-{n:02d}"), str(d.get("title") or d.get("name") or d.get("summary") or f"Case {n}"), steps if isinstance(steps, list) else [str(steps)],
                                    project=project, requirement=requirement_key, priority=str(d.get("priority") or "Medium").title(), who="ai", url=url)
                d["id"] = str(d.get("id") or f"TC-{suffix}-{n:02d}")
                r["data"]["items"][n - 1] = d
        return r
    return h


# ---- HAR
def har_handler():
    async def h(ctx):
        p = ctx.get("harPath")
        if not p:
            return {"unavailable": True, "detail": "the run did not record a HAR (the web run records one when it runs)"}
        try:
            har = json.loads(Path(p).read_text())
        except Exception as e:
            return {"ok": False, "detail": f"HAR could not be read: {e}"}
        entries = (har.get("log") or {}).get("entries", [])
        bad = [e for e in entries if (e.get("response") or {}).get("status", 0) >= 400]
        slow = [f"{round(e.get('time') or 0)}ms {str((e.get('request') or {}).get('url', '')).split('?')[0]}" for e in sorted(entries, key=lambda e: -(e.get("time") or 0))[:3]]
        return {"ok": True, "detail": f"{len(entries)} requests, {len(bad)} with status 400 or more; slowest: {'; '.join(slow) or 'none'}", "data": {"requests": len(entries), "failed": len(bad)}}
    return h


# ---- performance (Locust)
def locust_file(steps, base_url):
    calls = [{"m": str(s.get("method", "GET")).lower(), "u": re.sub(r"^https?://[^/]+", "", s["url"]) if re.match(r"https?:", s["url"], re.I) else s["url"], "b": s.get("body")} for s in steps if isinstance(s, dict) and s.get("kind") == "api" and s.get("url")]
    if not calls:
        return None
    q = json.dumps
    out = f"from locust import HttpUser, task, between\n\nclass Phoenix(HttpUser):\n    host = {q(base_url or '')}\n    wait_time = between(1, 3)\n"
    for i, c in enumerate(calls):
        m = c["m"] if c["m"] in ("get", "post", "put", "patch", "delete") else "get"
        out += f"\n    @task\n    def call_{i}(self):\n        self.client.{m}({q(c['u'])}{', json=' + q(c['b']) if c['b'] is not None and m != 'get' else ''})\n"
    return out


def locust_from_har(har, base_url=None):
    entries = [e for e in (har.get("log") or {}).get("entries", []) if re.match(r"https?:", (e.get("request") or {}).get("url", ""), re.I)]
    if not entries:
        return None
    first = urlparse(entries[0]["request"]["url"])
    host = urlparse(base_url).netloc if base_url else first.netloc
    steps, seen = [], set()
    for e in entries:
        u = urlparse(e["request"]["url"])
        if u.netloc != host or re.search(r"\.(png|jpe?g|gif|svg|ico|css|js|woff2?|map)$", u.path, re.I):
            continue
        m = str(e["request"].get("method", "GET")).upper()
        key = f"{m} {u.path}?{u.query}"
        if key in seen:
            continue
        seen.add(key)
        try:
            body = json.loads(e["request"]["postData"]["text"]) if (e["request"].get("postData") or {}).get("text") else None
        except Exception:
            body = None
        steps.append({"kind": "api", "method": m, "url": u.path + (f"?{u.query}" if u.query else ""), "body": body})
    return locust_file(steps, base_url or f"{first.scheme}://{host}")


def performance_handler(run=_run, directory="logs/performance", users=10, rate=2, duration="1m", max_fail_pct=1):
    async def h(ctx):
        if not ctx.get("baseUrl"):
            return {"unavailable": True, "detail": "give the API address (baseUrl) to run a load test"}
        code = None
        if ctx.get("harPath"):
            try:
                code = locust_from_har(json.loads(Path(ctx["harPath"]).read_text()), ctx["baseUrl"])
            except Exception:
                code = None
        code = code or locust_file(ctx.get("steps") or [], ctx["baseUrl"])
        if not code:
            return {"unavailable": True, "detail": "no HAR or API steps to turn into a load test"}
        if not _has("locust", run):
            return {"unavailable": True, "detail": "locust is not installed (pip install locust)"}
        d = Path(directory)
        d.mkdir(parents=True, exist_ok=True)
        (d / "locustfile.py").write_text(code)
        r = await asyncio.to_thread(run, ["locust", "-f", str(d / "locustfile.py"), "--headless", "-u", str(users), "-r", str(rate), "-t", duration, "--host", ctx["baseUrl"], "--csv", str(d / "run"), "--only-summary"])
        try:
            cols = (d / "run_stats.csv").read_text().strip().splitlines()[-1].split(",")
            reqs, fails = int(cols[2]), int(cols[3])
        except Exception:
            return {"ok": r.returncode == 0, "detail": f"locust finished (exit {r.returncode}); no stats file"}
        if not reqs:
            return {"ok": r.returncode == 0, "detail": f"locust finished (exit {r.returncode}); no stats file"}
        pct = 100 * fails / reqs
        return {"ok": pct <= max_fail_pct, "detail": f"{reqs} requests, {fails} failed ({pct:.1f}%) at {users} users for {duration}"}
    return h


# ---- DAST (ZAP)
async def zap_api(api, key, url, ajax_spider=False, fetch=_http.fetch, wait=asyncio.sleep, max_polls=120):
    async def call(path, **params):
        q = httpx.QueryParams({**params, "apikey": key or ""})
        status, text = await fetch("GET", f"{api.rstrip('/')}{path}?{q}")
        if status >= 400:
            raise RuntimeError(f"ZAP {path} failed ({status}).")
        return json.loads(text)
    await call("/JSON/core/action/accessUrl", url=url, followRedirects="true")
    sp = await call("/JSON/spider/action/scan", url=url, recurse="true")
    for _ in range(max_polls):
        if int((await call("/JSON/spider/view/status", scanId=sp["scan"]))["status"]) >= 100:
            break
        await wait(1)
    if ajax_spider:
        await call("/JSON/ajaxSpider/action/scan", url=url)
        for _ in range(max_polls):
            if (await call("/JSON/ajaxSpider/view/status"))["status"] == "stopped":
                break
            await wait(1)
    for _ in range(max_polls):
        if int((await call("/JSON/pscan/view/recordsToScan"))["recordsToScan"]) == 0:
            break
        await wait(1)
    s = (await call("/JSON/alert/view/alertsSummary", baseurl=url)).get("alertsSummary") or {}
    return {"high": int(s.get("High", 0)), "medium": int(s.get("Medium", 0)), "low": int(s.get("Low", 0)), "info": int(s.get("Informational", 0))}


def dast_handler(run=_run, directory="logs/security", env=None, fetch=_http.fetch, wait=asyncio.sleep):
    env = env if env is not None else os.environ

    async def h(ctx):
        url = ctx.get("appUrl") or ctx.get("baseUrl")
        if not url:
            return {"unavailable": True, "detail": "give the app address to scan"}
        if env.get("ZAP_API_URL"):
            try:
                c = await zap_api(env["ZAP_API_URL"], env.get("ZAP_API_KEY"), url, bool(ctx.get("ajaxSpider")), fetch, wait)
                return {"ok": c["high"] == 0, "detail": f"ZAP alerts: {c['high']} high, {c['medium']} medium, {c['low']} low, {c['info']} informational", "data": {"alerts": c}}
            except Exception as e:
                return {"ok": False, "detail": f"ZAP scan failed: {e}"}
        Path(directory).mkdir(parents=True, exist_ok=True)
        local = _has("zap-baseline.py", run)
        if not local and not _has("docker", run):
            return {"unavailable": True, "detail": "ZAP is not set up: set ZAP_API_URL (a ZAP daemon), or install zap-baseline.py or docker"}
        extra = ["-j"] if ctx.get("ajaxSpider") else []
        rep = ["-J", str(Path(directory, "zap.json")) if local else "zap.json", "-r", str(Path(directory, "zap.html")) if local else "zap.html"]
        args = ["zap-baseline.py", "-t", url, *rep, *extra] if local else ["docker", "run", "--rm", "-v", f"{Path(directory).resolve()}:/zap/wrk", "zaproxy/zap-stable", "zap-baseline.py", "-t", url, *rep, *extra]
        r = await asyncio.to_thread(run, args)
        return {"ok": r.returncode == 0, "detail": "no alerts" if r.returncode == 0 else "warnings found (see report)" if r.returncode == 2 else "failures found (see report)" if r.returncode == 1 else f"scan error (exit {r.returncode})"}
    return h


# ---- unit tests (AI) and the pull request
def unittests_handler(call_json, get_prompt, connect_repo, max_files=5):
    async def h(ctx):
        if not call_json:
            return {"unavailable": True, "detail": "no model configured"}
        rq = ctx.get("repoRequest")
        if not rq or not rq.get("project"):
            return {"unavailable": True, "detail": "give a repo (provider and project) to write unit tests for"}
        try:
            repo = connect_repo(rq)
        except Exception as e:
            return {"unavailable": True, "detail": str(e)}
        ref = rq.get("ref") or await repo.default_branch()
        allf = await repo.list_files(ref)
        findings = (next((s for s in ctx.get("results", []) if s["id"] == "sast"), {}).get("data") or {}).get("findings") or {}
        files = unit_tests.pick_files(allf, rq.get("files"), list(findings), rq.get("max") or max_files, rq.get("languages"))
        if not files:
            return {"ok": True, "detail": "no source files in a supported language to test", "data": {"tests": [], "skipped": []}}
        r = await unit_tests.generate_tests(files, lambda f: repo.read_file(f, ref), call_json, get_prompt, findings)
        langs = sorted({f["language"] for f in r["files"]})
        return {"ok": bool(r["files"]), "detail": f"{len(r['files'])} test file(s) written{' (' + ', '.join(langs) + ')' if langs else ''}, {len(r['skipped'])} skipped{': ' + r['skipped'][0]['why'] if r['skipped'] else ''}",
                "data": {"tests": r["files"], "skipped": r["skipped"], "ref": ref}}
    return h


def testspr_handler(connect_repo):
    async def h(ctx):
        u = next((s for s in ctx.get("results", []) if s["id"] == "unittests"), {}).get("data")
        if not u or not u.get("tests"):
            return {"unavailable": True, "detail": "no tests to commit"}
        repo = connect_repo(ctx["repoRequest"])
        branch = f"testops/ai-unit-tests-{int(time.time() * 1000):x}"
        n = len(u["tests"])
        pr = await repo.open_pull_request(u["ref"], branch, f"AI-generated unit tests ({n} file{'s' if n > 1 else ''})", [{"path": t["path"], "content": t["content"]} for t in u["tests"]],
                                          "Written by Phoenix. Review before merging: the tests have not been run. Your CI runs them on this branch.\n\n" + "\n".join(f"- {t['path']} ({t['language']}{', covers a Semgrep finding' if t['flagged'] else ''})" for t in u["tests"]))
        return {"ok": True, "detail": f"opened {pr['url']}", "data": {"url": pr["url"], "branch": pr["branch"]}}
    return h


def traceability_handler(call_json, connect_repo):
    async def h(ctx):
        rq = ctx.get("repoRequest")
        if not str(ctx.get("requirement") or "").strip():
            return {"unavailable": True, "detail": "no requirement text to compare"}
        if not rq or not rq.get("project"):
            return {"unavailable": True, "detail": "give the repo (provider and project) where the sessions are stored"}
        try:
            repo = connect_repo(rq)
        except Exception as e:
            return {"unavailable": True, "detail": str(e)}
        r = await traceability.check(ctx["requirement"], repo, rq.get("ref"), call_json)
        s = r["summary"]
        how = "" if r["source"] == "ai" else " (word match, a guess: no model judged it)"
        return {"ok": s["missing"] == 0 and s["partial"] == 0, "detail": f"{s['requirements']} requirements, {s['tests']} tests in the repo: {s['covered']} covered, {s['partial']} partial, {s['missing']} missing" + (f", {s['possible']} possible" if s["possible"] else "") + f", {s['unrequired']} built without a requirement{how}",
                "data": {"traceability": r}}
    return h


def aieval_handler(run=_run, env=None, run_id=""):
    async def h(ctx):
        ev = ctx.get("evaluate")
        if not ev or (not ev.get("conversation") and not ev.get("turns")):
            return {"unavailable": True, "detail": "give a conversation to evaluate (User: / Bot: lines, or turns)"}
        r = await asyncio.to_thread(ai_eval.evaluate, ev.get("turns"), ev.get("conversation"), ev.get("metrics"), ev.get("threshold", 0.5), ev.get("criteria"), run, env, run_id=run_id)
        if r["status"] == "unavailable":
            return {"unavailable": True, "detail": r["why"]}
        if r["status"] == "error":
            return {"ok": False, "detail": r["why"]}
        s = r["summary"]
        m = ", ".join(f"{k} {v['avg']}" for k, v in s["byMetric"].items())
        return {"ok": s["failed"] == 0, "detail": f"{s['passed']} of {s['scored']} checks passed over {s['turns']} turn(s)" + (f" ({m})" if m else "") + (f"; {s['skipped']} skipped" if s["skipped"] else ""), "data": {"evaluation": r["results"], "summary": s}}
    return h


def signoff_handler(run_id, url=None):
    """Asks people to sign off. The AI never approves: it files the requests, and the trail shows who decided."""
    async def h(ctx):
        cases = [c for c in signoff.list_cases(requirement=ctx.get("requirementKey") or None, url=url)] if ctx.get("requirementKey") else []
        made = 0
        for c in cases:
            if c["signoff"] in ("draft", "changes-requested", "rejected"):
                signoff.request_case(c["id"], "Phoenix AI", "requested by the pipeline", url)
                made += 1
        try:
            signoff.request_run(run_id, "Phoenix AI", "requested by the pipeline", url)
            run_req = True
        except signoff.SignoffError:
            run_req = False
        return {"ok": True, "detail": f"sign-off requested for {made} test case(s)" + (" and for the run" if run_req else "") + "; waiting for a person to decide", "data": {"cases": made}}
    return h


def feedback_handler(directory="logs/reports"):
    async def h(ctx):
        Path(directory).mkdir(parents=True, exist_ok=True)
        f = Path(directory, f"{int(time.time() * 1000)}.json")
        f.write_text(json.dumps({"goal": ctx.get("goal", ""), "stages": [{"id": s["id"], "status": s["status"], "detail": str(s.get("detail") or "")[:300]} for s in ctx.get("results", [])]}, indent=2))
        return {"ok": True, "detail": f"report saved: {f}"}
    return h


def tool_status(run=_run, env=None):
    env = env if env is not None else os.environ
    out = {c: _has(c, run) for c in ("locust", "semgrep", "gitleaks")}
    out["python"] = True
    out["node"] = "reachable" if env.get("ENGINE_URL") else False
    out["zap"] = "daemon configured" if env.get("ZAP_API_URL") else ("zap-baseline.py" if _has("zap-baseline.py", run) else "via docker" if _has("docker", run) else False)
    av = ai_eval.available(run, env)
    out["deepeval"] = "installed, judge set" if av["ok"] else False
    out["deepevalWhy"] = None if av["ok"] else av["why"]
    out["jira"] = all(env.get(k) for k in ("JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"))
    out["github"], out["gitlab"] = bool(env.get("GITHUB_TOKEN")), bool(env.get("GITLAB_TOKEN"))
    out["browserstack"] = bool(env.get("TESTOPS_MOBILE_BROWSERSTACK_USER") and env.get("TESTOPS_MOBILE_BROWSERSTACK_KEY"))
    out["ollama"] = any(env.get(k) for k in ("OLLAMA_HOST", "TESTOPS_OLLAMA_URL", "OLLAMA_URL", "TESTOPS_MOBILE_OLLAMA_HOST"))
    out["clickhouse"] = bool(env.get("CLICKHOUSE_URL"))
    out["postgres"] = str(env.get("DATABASE_URL", "")).startswith(("postgres", "postgresql"))
    return out
