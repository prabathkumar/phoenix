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

from . import llm as _llm, ai_eval, jira as J, prompt_store, signoff, traceability, unit_tests
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
        if not items and isinstance(r, dict):
            # smaller models often pick their own key ("test_scenarios", "data"...): take the one list of objects they sent
            lists = [v for v in r.values() if isinstance(v, list) and v and all(isinstance(x, dict) for x in v)]
            items = lists[0] if len(lists) == 1 else None
        if not items:
            seen = ("a list" if isinstance(r, list) else ("keys: " + ", ".join(list(r)[:6]) if isinstance(r, dict) and r else "an empty answer"))
            return {"ok": False, "detail": f"the model returned nothing usable ({p['id']}); it sent {seen}"}
        return {"ok": True, "detail": f"{len(items)} from {p['id']}", "data": {"items": items}}
    return h


def scenarios_handler(call_json, get_prompt):
    return ai_handler("scenario_batch", call_json, get_prompt, lambda c: f"REQUIREMENT:\n{str(c.get('requirement') or '')[:6000]}")


def cases_handler(call_json, get_prompt, project="", requirement_key="", run_id="", url=None, scenario_label=""):
    def user_of(c):
        sc = next((s for s in c.get("results", []) if s["id"] == "scenarios"), {}).get("data") or {}
        return f"REQUIREMENT:\n{str(c.get('requirement') or '')[:3000]}\nSCENARIOS:\n{json.dumps(sc.get('items', []))[:4000]}"
    inner = ai_handler("testcase_target", call_json, get_prompt, user_of)

    async def h(ctx):
        r = await inner(ctx)
        if r.get("ok"):  # keep them: people sign off these cases, in Postgres
            suffix = run_id[-6:] if run_id else "000000"
            label = f"{str(scenario_label or requirement_key or 'run')[:100]} ({suffix})"  # one batch of cases = one scenario; the run's short id keeps batches apart
            for n, it in enumerate(r["data"]["items"], 1):
                d = it if isinstance(it, dict) else {"title": str(it)}
                steps = d.get("steps") or d.get("instructions") or []
                signoff.upsert_case(str(d.get("id") or f"TC-{suffix}-{n:02d}"), str(d.get("title") or d.get("name") or d.get("summary") or f"Case {n}"), steps if isinstance(steps, list) else [str(steps)],
                                    project=project, requirement=requirement_key, priority=str(d.get("priority") or "Medium").title(), who="ai", url=url,
                                    scenario=label)
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
def safe_target(url):
    """A scan or load test goes only to a plain http(s) address: no file:, ftp:, javascript:, no credentials in the URL, and never the cloud metadata
    or link-local range (169.254.x.x, fd00:ec2::254), which would let a caller read the server's own cloud credentials. Returns an error text, or None if fine."""
    try:
        u = urlparse(str(url))
        host = (u.hostname or "").lower()
    except ValueError:
        return "that address is not a valid URL"
    if u.scheme not in ("http", "https") or not host:
        return "only http:// or https:// addresses can be scanned or load tested"
    if u.username or u.password:
        return "the address must not contain a user name or password"
    import ipaddress
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_link_local or host in ("fd00:ec2::254",):
            return "link-local and cloud-metadata addresses are not allowed"
    except ValueError:
        if host in ("metadata.google.internal", "metadata", "instance-data"):
            return "cloud-metadata hosts are not allowed"
    return None


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
        bad = safe_target(ctx["baseUrl"])
        if bad:
            return {"unavailable": True, "detail": f"not allowed: {bad}"}
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
        bad = safe_target(url)
        if bad:
            return {"unavailable": True, "detail": f"not allowed: {bad}"}
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
    """Writes unit tests with the AI for the requirement and for the code that changed (a developer feature: unit tests were never part of TestOps).
    Request: repoRequest {provider, project, ref?, base?+head? (compare two refs: only changed source files), files?, languages?, max?} and the requirement
    from ctx (requirementKey, requirement) or repoRequest.requirement {key, text}. Changed files come first; Semgrep-flagged files next."""
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
        ref = rq.get("head") or rq.get("ref") or await repo.default_branch()
        allf = await repo.list_files(ref)
        findings = (next((s for s in ctx.get("results", []) if s["id"] == "sast"), {}).get("data") or {}).get("findings") or {}
        changes = {}
        if rq.get("base") and rq.get("head"):
            try:
                changes = {c["path"]: c["patch"] for c in await repo.changed_files(rq["base"], rq["head"]) if c.get("status") != "removed"}
            except Exception as e:
                return {"unavailable": True, "detail": f"could not compare {rq['base']}...{rq['head']}: {e}"}
            if not changes:
                return {"ok": True, "detail": f"nothing changed between {rq['base']} and {rq['head']}", "data": {"tests": [], "skipped": [], "ref": ref}}
        req = rq.get("requirement") if isinstance(rq.get("requirement"), dict) else {}
        requirement = {"key": str(req.get("key") or ctx.get("requirementKey") or "")[:40], "text": str(req.get("text") or ctx.get("requirement") or "")[:3000]}
        only = rq.get("files") or (list(changes) if changes else None)
        order = list(changes) + [f for f in findings if f not in changes]
        files = unit_tests.pick_files(allf, only, order, rq.get("max") or max_files, rq.get("languages"))
        if not files:
            return {"ok": True, "detail": "no source files in a supported language to test", "data": {"tests": [], "skipped": []}}
        return await _finish_unit(rq, ref, allf, files, findings, changes, requirement, call_json, get_prompt, _CachedRepo(repo, {}))
    return h


class _CachedRepo:
    def __init__(self, repo, cache):
        self._r, self._c = repo, cache

    def __getattr__(self, n):
        return getattr(self._r, n)

    async def read_file(self, f, ref):
        if f not in self._c:
            self._c[f] = await self._r.read_file(f, ref)
        return self._c[f]


async def _finish_unit(rq, ref, allf, files, findings, changes, requirement, call_json, get_prompt, repo):
    if True:  # (kept at this indent)
        r = await unit_tests.generate_tests(files, lambda f: repo.read_file(f, ref), call_json, get_prompt, findings, requirement=requirement, changes=changes)
        for t in r["files"]:
            t["kind"], t["layer"] = "unit", "code"
        api = {"endpoints": [], "specFiles": []}
        if rq.get("api", True):
            api, a = await _api_tests(repo, ref, allf, rq, changes, call_json, get_prompt, requirement)
            r["files"] += a["files"]
            r["skipped"] += a["skipped"]
        langs = sorted({f["language"] for f in r["files"]})
        nu, na = sum(1 for f in r["files"] if f["kind"] == "unit"), sum(1 for f in r["files"] if f["kind"] == "integration")
        return {"ok": bool(r["files"]), "detail": f"{nu} unit and {na} API integration test file(s) written{' (' + ', '.join(langs) + ')' if langs else ''}{' for ' + requirement['key'] if requirement['key'] else ''}, {len(r['skipped'])} skipped{': ' + r['skipped'][0]['why'] if r['skipped'] else ''}",
                "data": {"tests": r["files"], "skipped": r["skipped"], "ref": ref, "requirement": requirement["key"], "changedFiles": len(changes),
                         "api": {"endpoints": len(api["endpoints"]), "specFiles": api["specFiles"], "calls": [{k: e.get(k) for k in ("method", "path", "file", "testData")} for e in api["endpoints"][:40]]}}}


async def _api_tests(repo, ref, allf, rq, changes, call_json, get_prompt, requirement, max_files=40):
    """The API layer of the repo: calls found in code or an OpenAPI file, test data from their schema, one integration test file per source file."""
    from . import api_layer
    cand = [f for f in allf if api_layer.SPEC_NAME.search(f) and not changes][:3] + unit_tests_pick(allf, rq.get("languages"), changes)[:max_files]
    texts = {}
    for f in cand:
        try:
            t = await repo.read_file(f, ref)
            if len(t) <= 200000:
                texts[f] = t
        except Exception:
            pass
    layer = api_layer.analyse(allf, texts, unit_tests.language_of)
    eps = layer["endpoints"]
    if changes:                                   # when two refs are compared, only calls in changed files (or from the spec) are tested
        eps = [e for e in eps if e["file"] in changes or e["source"] == "openapi"]
    code_eps = [e for e in eps if unit_tests.language_of(e["file"])]
    spec_eps = [e for e in eps if e["source"] == "openapi"]
    if spec_eps and not code_eps:                 # spec only: write the tests in the repo's main language
        lang = (rq.get("languages") or [None])[0] or next((unit_tests.language_of(f) for f in allf if unit_tests.language_of(f)), None)
        anchor = next((f for f in allf if unit_tests.language_of(f) == lang), None)
        if anchor:
            ext = unit_tests.LANGS[lang]["ext"][0]
            code_eps = [dict(e, file=posixpath_join("api", "spec" + ext)) for e in spec_eps]
    gen = await unit_tests.generate_api_tests(code_eps, None, call_json, get_prompt, requirement=requirement) if code_eps else {"files": [], "skipped": []}
    return {"endpoints": eps, "specFiles": layer["specFiles"]}, gen


def unit_tests_pick(allf, languages, changes):
    ok = [f for f in allf if unit_tests.language_of(f) and not unit_tests.IS_TEST.search(f) and not unit_tests.IGNORE.search(f) and (not languages or unit_tests.language_of(f) in languages)]
    return [f for f in ok if f in changes] if changes else ok


def posixpath_join(*a):
    import posixpath
    return posixpath.join(*a)


def repolink_handler(connect_repo):
    """Link a repo: which languages it holds, which test frameworks, how many tests exist, and which API calls it offers. Called straight after the link so the next step can be offered at once."""
    async def h(ctx):
        from . import api_layer, test_connectors
        rq = ctx.get("repoRequest")
        if not rq or not rq.get("project"):
            return {"unavailable": True, "detail": "give a repo (provider and project) to link"}
        try:
            repo = connect_repo(rq)
            ref = rq.get("ref") or await repo.default_branch()
            allf = await repo.list_files(ref)
        except Exception as e:
            return {"unavailable": True, "detail": str(e)}
        langs = {}
        for f in allf:
            if unit_tests.IGNORE.search(f):
                continue
            l = unit_tests.language_of(f)
            if l:
                d = langs.setdefault(l, {"source": 0, "tests": 0})
                d["tests" if unit_tests.IS_TEST.search(f) else "source"] += 1
        specs = [f for f in allf if api_layer.SPEC_NAME.search(f)]
        routes = 0
        for f in [f for f in allf if unit_tests.language_of(f) and not unit_tests.IS_TEST.search(f) and not unit_tests.IGNORE.search(f)][:60]:
            if routes > 500:
                break
            try:
                routes += len(api_layer.detect_endpoints(f, await repo.read_file(f, ref), unit_tests.language_of(f)))
            except Exception:
                pass
        avail = test_connectors.availability()
        out = [{"language": l, "sourceFiles": v["source"], "testFiles": v["tests"], "toolchainHere": bool(avail.get(l, {}).get("available")), "framework": unit_tests.LANGS[l]["framework"]} for l, v in sorted(langs.items(), key=lambda x: -x[1]["source"])]
        main = out[0]["language"] if out else None
        return {"ok": bool(out), "detail": (f"{', '.join(o['language'] for o in out)} found; {routes} API call(s) in code" + (f" and {len(specs)} OpenAPI file(s)" if specs else "") + ". Ready to write unit and API integration tests.") if out else "no supported language found in this repo",
                "data": {"ref": ref, "languages": out, "main": main, "apiCalls": routes, "openapi": specs, "next": "unit-tests"}}
    return h


def unitrun_handler(project="", run_id="", env=None, run=None, which=None):
    """Runs the repo's unit and integration tests per language with the language's own toolchain, and logs every test against its requirement key.
    Request: repoRequest {dir | cloneUrl(+ref), languages?, kinds?}. May be run again and again: each run is stored under its own run id."""
    async def h(ctx):
        import shutil
        from . import logstore, test_connectors as tcx
        rq = ctx.get("repoRequest") or {}
        root, cleanup = rq.get("dir"), False
        e = env if env is not None else os.environ
        try:
            # Running a repo's tests runs its code. So only folders under PHOENIX_UNIT_ROOT (default: none) and clone URLs on PHOENIX_UNIT_CLONE_HOSTS (default: none) are allowed.
            if root:
                base = e.get("PHOENIX_UNIT_ROOT", "")
                real = os.path.realpath(str(root))
                if not base or not (real == os.path.realpath(base) or real.startswith(os.path.realpath(base) + os.sep)):
                    return {"unavailable": True, "detail": "that folder is not allowed: set PHOENIX_UNIT_ROOT to the folder that holds checkouts the platform may run (running tests runs the repo's code)"}
                root = real
            elif rq.get("cloneUrl"):
                host = (re.match(r"^https://([\w.-]+)/", str(rq["cloneUrl"])) or [None, ""])[1].lower()
                if host not in [x.strip().lower() for x in e.get("PHOENIX_UNIT_CLONE_HOSTS", "").split(",") if x.strip()]:
                    return {"unavailable": True, "detail": f"cloning from '{host or rq['cloneUrl']}' is not allowed: list trusted hosts in PHOENIX_UNIT_CLONE_HOSTS (running tests runs the repo's code)"}
                root, cleanup = tcx.clone(rq["cloneUrl"], rq.get("ref", "")), True
            if not root or not os.path.isdir(root):
                return {"unavailable": True, "detail": "give a checkout to run: repoRequest.dir (a folder on the server) or repoRequest.cloneUrl (https)"}
            kw = {k: v for k, v in (("run", run), ("which", which)) if v}
            if rq.get("apiBaseUrl"):
                bad = safe_target(rq["apiBaseUrl"])
                if bad:
                    return {"unavailable": True, "detail": f"apiBaseUrl not allowed: {bad}"}
                kw["env"] = {**os.environ, "API_BASE_URL": str(rq["apiBaseUrl"])}
            results = tcx.run_all(root, rq.get("languages"), tuple(rq.get("kinds") or ("unit", "integration")), **kw)
        except (ValueError, OSError) as e:
            return {"unavailable": True, "detail": str(e)}
        finally:
            if cleanup and root:
                shutil.rmtree(root, ignore_errors=True)
        if not results:
            return {"unavailable": True, "detail": "no supported language found in that checkout (looked for package.json, pom.xml, go.mod, composer.json, pyproject/requirements, a .csproj)"}
        for r in results:
            for t in r["tests"]:
                logstore.record("unit_result", {"project": project, "run": run_id, "requirement": t["requirement"], "language": r["language"], "kind": r["kind"], "test": t["name"], "status": t["status"], "ms": t["ms"]}, env)
        ran = [r for r in results if r["tests"]]
        failed = sum(r["summary"]["failed"] for r in ran)
        passed = sum(r["summary"]["passed"] for r in ran)
        missing = [f"{r['language']} {r['kind']}: {r['detail']}" for r in results if not r["tests"]]
        return {"ok": bool(ran) and failed == 0, "detail": f"{passed} passed, {failed} failed across {len(ran)} run(s)" + (f"; no result for {len(missing)}: {missing[0]}" if missing else ""),
                "data": {"runs": [{k: r[k] for k in ("language", "kind", "ok", "available", "detail", "summary")} for r in results],
                         "failures": [{"language": r["language"], "kind": r["kind"], "name": str(t["name"])[:200], "requirement": t.get("requirement")} for r in ran for t in r["tests"] if t["status"] == "failed"][:50]}}
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


def signoff_handler(run_id, url=None, actor="Phoenix AI"):
    """Asks people to sign off. The AI never approves: it files the requests, and the trail shows who decided."""
    async def h(ctx):
        cases = [c for c in signoff.list_cases(requirement=ctx.get("requirementKey") or None, url=url)] if ctx.get("requirementKey") else []
        made = 0
        for c in cases:
            if c["signoff"] in ("draft", "changes-requested", "rejected"):
                signoff.request_case(c["id"], actor, "requested by the pipeline" + ("" if actor == "Phoenix AI" else f" (avatar of {actor})"), url)
                made += 1
        try:
            signoff.request_run(run_id, actor, "requested by the pipeline" + ("" if actor == "Phoenix AI" else f" (avatar of {actor})"), url)
            run_req = True
        except signoff.SignoffError:
            run_req = False
        return {"ok": True, "detail": f"sign-off requested for {made} test case(s)" + (" and for the run" if run_req else "") + "; waiting for a person to decide", "data": {"cases": made}}
    return h


def measure_handler(project="", url=None, env=None):
    """Gauge: computes the KPIs and the indicative TMMI view from this platform's own logs and says where it stands. Reads only; changes nothing."""
    async def h(ctx):
        from . import kpi
        r = kpi.report(project or None, 30, url, env)
        k, t = r["kpis"], r["tmmi"]
        q = r["quality"]
        return {"ok": True, "detail": f"pass rate {k['passRate']}, flaky {k['flakyRate']}, defect leakage {q['defectLeakage']}, unit-test leakage {q['unitTestLeakage']}, DDP {q['defectDetectionPercentage']}; indicative TMMI level {t['achieved']}", "data": {"kpis": k, "quality": q, "tmmi": t["achieved"]}}
    return h


def feedback_handler(directory="logs/reports", project="", run_id=""):
    async def h(ctx):
        try:  # every stage of the run also goes to the log store, so the run is queryable by project, agent and day
            from . import logstore
            for s_ in ctx.get("results", []):
                logstore.record("agent_event", {"project": project, "run": run_id, "agent": s_["id"], "event": "stage", "status": s_["status"], "ms": s_.get("ms", 0), "detail": str(s_.get("detail") or "")[:300]})
        except Exception:  # noqa: BLE001
            pass
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
    out["ollama"] = _llm.provider(env) == "ollama"
    out["model"] = _llm.provider(env) or False  # the model door the platform actually uses
    out["clickhouse"] = bool(env.get("CLICKHOUSE_URL"))
    out["postgres"] = str(env.get("DATABASE_URL", "")).startswith(("postgres", "postgresql"))
    return out


def apifunc_handler(connect_repo, fetch=_http.fetch, env=None):
    """The agent builds functional API tests from the repo's API layer (code or OpenAPI) and runs them against a base URL, then logs each case.
    Request: repoRequest {provider, project, ref?, languages?} + apiBaseUrl (+ allowWrites, requirement {key}). Without apiBaseUrl it only plans (returns the cases)."""
    async def h(ctx):
        from . import api_layer, api_functional as AF, logstore
        rq = ctx.get("repoRequest") or {}
        if not rq.get("project"):
            return {"unavailable": True, "detail": "give a repo (provider and project) whose API should be tested"}
        base = rq.get("apiBaseUrl") or ctx.get("apiBaseUrl")
        if base:
            bad = safe_target(base)
            if bad:
                return {"unavailable": True, "detail": f"apiBaseUrl not allowed: {bad}"}
        try:
            repo = connect_repo(rq)
            ref = rq.get("ref") or await repo.default_branch()
            allf = await repo.list_files(ref)
        except Exception as e:
            return {"unavailable": True, "detail": str(e)}
        cand = [f for f in allf if api_layer.SPEC_NAME.search(f)][:3] + unit_tests_pick(allf, rq.get("languages"), {})[:60]
        texts = {}
        for f in cand:
            try:
                t = await repo.read_file(f, ref)
                if len(t) <= 200000:
                    texts[f] = t
            except Exception:
                pass
        eps = api_layer.analyse(allf, texts, unit_tests.language_of)["endpoints"]
        if not eps:
            return {"ok": False, "detail": "no API calls found in this repo (no routes in code and no OpenAPI file)", "data": {"cases": [], "results": []}}
        key = str((rq.get("requirement") or {}).get("key") or ctx.get("requirementKey") or "")[:40]
        cases = AF.build_cases(eps, key)
        brief = [{k: c[k] for k in ("name", "call", "method", "path", "writes")} for c in cases]
        if not base:
            return {"ok": True, "detail": f"{len(cases)} functional API case(s) planned for {len(eps)} call(s); give apiBaseUrl to run them", "data": {"cases": brief, "results": [], "calls": len(eps)}}
        e = env if env is not None else os.environ
        res = await AF.run_cases(base, cases, fetch, bool(rq.get("allowWrites")), e.get("API_TOKEN", ""))
        run_id = str(ctx.get("run") or int(time.time()))
        for r in res:
            logstore.record("unit_result", {"project": ctx.get("project", ""), "run": run_id, "requirement": key, "language": "api", "kind": "functional", "test": r["name"], "status": r["result"], "ms": r["ms"]}, env)
        sm = AF.summary(res)
        return {"ok": sm["failed"] == 0 and sm["passed"] > 0, "detail": f"{sm['passed']} passed, {sm['failed']} failed, {sm['skipped']} skipped across {len(eps)} call(s)" + ("" if rq.get("allowWrites") else " (writes off)"),
                "data": {"summary": sm, "results": res, "calls": len(eps), "run": run_id}}
    return h


def deployed_handler(fetch=_http.fetch):
    """After the deployment: the app must answer before the security test is allowed to aim at it. Any answer below 500 counts as up."""
    async def h(ctx):
        url = ctx.get("appUrl") or ctx.get("baseUrl")
        if not url:
            return {"unavailable": True, "detail": "give the deployed app address (appUrl) to check"}
        bad = safe_target(url)
        if bad:
            return {"unavailable": True, "detail": f"not allowed: {bad}"}
        try:
            status, _ = await fetch("GET", str(url), {"Accept": "text/html,application/json"}, None)
        except Exception as e:
            return {"ok": False, "detail": f"the app did not answer: {str(e)[:120]}"}
        return {"ok": status < 500, "detail": f"the app answered {status}" if status < 500 else f"the app is failing ({status}), so the security test waits", "data": {"status": status}}
    return h


def evidence_handler(project="", run_id="", env=None, dirs=None):
    """After the run: reports, screenshots, HAR and logs go into one compressed archive, which is checked, and the AI is given a digest."""
    async def h(ctx):
        from . import evidence
        e = env if env is not None else os.environ
        ds = [d for d in (dirs or [e.get("PHOENIX_REPORTS_DIR", "logs/reports"), e.get("PHOENIX_SCREENSHOT_DIR", "logs/screenshots"), "logs/security"]) if os.path.isdir(d)]
        extra = {"stages.json": json.dumps([{k: s.get(k) for k in ("id", "status", "detail")} for s in ctx.get("results", [])])}
        if ctx.get("testDataUsed"):
            extra["test-data.json"] = json.dumps(ctx["testDataUsed"])
        b = await asyncio.to_thread(evidence.bundle, run_id, ds, e.get("PHOENIX_EVIDENCE_DIR", "logs/evidence"), extra)
        v = await asyncio.to_thread(evidence.validate, b["path"])
        dig = evidence.digest(b["manifest"], ctx.get("results", []), ctx.get("goal", ""))
        trained = evidence.feed(project, run_id, dig, e)
        return {"ok": v["ok"], "detail": f"{b['files']} file(s) packed ({b['rawBytes']} to {b['packedBytes']} bytes), " + ("checked: all good" if v["ok"] else "check FAILED: " + "; ".join(v["problems"][:2])) + f"; the AI was given the digest{' and a training example to label' if trained else ' (training capture is off)'}",
                "data": {"archive": b["path"], "ratio": b["ratio"], "validation": v, "screenshots": v["screenshots"]}}
    return h


def revalidate_handler(connect_repo, fetch=_http.fetch, env=None, run=None, which=None):
    """The agents check what the AI wrote, again: FLAKY (everything repeated, mixed results are named), FUNCTIONAL (the API cases from the schema) and
    NEGATIVE (invalid data from the schema and synthetic hostile data on every text field: never a 5xx, never accepted when invalid).
    Request: repoRequest {provider, project, apiBaseUrl?, allowWrites?, dir?, repeat?}. Any part with nothing to run is said plainly."""
    async def h(ctx):
        from . import api_layer, api_functional as AF, logstore, test_connectors as tcx
        rq = ctx.get("repoRequest") or {}
        times = max(2, min(int(rq.get("repeat") or 3), 10))
        run_id = str(ctx.get("run") or int(time.time()))
        project, parts, flaky, bad = ctx.get("project", ""), {}, [], []
        base = rq.get("apiBaseUrl") or ctx.get("apiBaseUrl")
        if base and rq.get("project"):
            if safe_target(base):
                return {"unavailable": True, "detail": f"apiBaseUrl not allowed: {safe_target(base)}"}
            try:
                repo = connect_repo(rq)
                ref = rq.get("ref") or await repo.default_branch()
                allf = await repo.list_files(ref)
                texts = {}
                for f in [f for f in allf if api_layer.SPEC_NAME.search(f)][:3] + unit_tests_pick(allf, rq.get("languages"), {})[:60]:
                    try:
                        texts[f] = await repo.read_file(f, ref)
                    except Exception:
                        pass
                eps = api_layer.analyse(allf, texts, unit_tests.language_of)["endpoints"]
            except Exception as e:
                return {"unavailable": True, "detail": str(e)}
            key = str((rq.get("requirement") or {}).get("key") or "")[:40]
            for label, cases in (("functional", AF.build_cases(eps, key)), ("negative", [c for c in AF.build_cases(eps, key) if c["expect"]["status"] == "4xx" or c["expect"]["status"] == 404] + AF.hostile_cases(eps, key))):
                if not cases:
                    parts[label] = {"ran": 0, "detail": "no cases (no API calls found)"}
                    continue
                rows, fl = await AF.run_repeated(base, cases, fetch, times, bool(rq.get("allowWrites")), (env if env is not None else os.environ).get("API_TOKEN", ""))
                ran = [r for r in rows if r["result"] != "skipped"]
                failed = [r for r in ran if r["result"] == "failed"]
                parts[label] = {"ran": len(ran), "failed": len(failed), "flaky": len(fl), "skipped": len(rows) - len(ran), "firstFailures": [f"{r['name']}: {r['detail']}" for r in failed[:5]]}
                flaky += fl
                bad += [f"{label}: {r['name']}" for r in failed]
                for r in ran:
                    logstore.record("unit_result", {"project": project, "run": run_id, "requirement": key, "language": "api", "kind": label, "test": r["name"], "status": "failed" if r["result"] in ("failed", "flaky") else "passed", "ms": 0}, env)
        if rq.get("dir"):
            rep = {"dir": rq["dir"], **{k: rq[k] for k in ("languages",) if k in rq}}
            seen, tallies = {}, 0
            for n in range(times):
                r = await unitrun_handler(project, f"{run_id}-r{n + 1}", env, run, which)({"repoRequest": rep})
                if r.get("unavailable"):
                    parts["unit"] = {"ran": 0, "detail": r["detail"]}
                    break
                tallies += 1
                for x in (r.get("data") or {}).get("runs", []):
                    seen.setdefault((x["language"], x["kind"]), []).append(x["ok"])
            if tallies:
                fl = [f"{l} {k}" for (l, k), v in seen.items() if len(set(v)) > 1]
                parts["unit"] = {"ran": tallies, "flaky": len(fl), "failed": sum(1 for v in seen.values() if not all(v))}
                flaky += [f"unit: {x}" for x in fl]
                bad += [f"unit: {l} {k} failed" for (l, k), v in seen.items() if not any(v)]
        if not any(p.get("ran") for p in parts.values()):
            return {"unavailable": True, "detail": "nothing to re-check: give a repo with apiBaseUrl (API checks) and/or a checkout folder (unit and integration checks)" if not parts else "; ".join(f"{k}: {v.get('detail', 'nothing ran')}" for k, v in parts.items()), "data": {"parts": parts}}
        return {"ok": not bad and not flaky, "detail": f"repeated {times} times: {len(bad)} failing, {len(flaky)} flaky" + (f" (first: {(bad or flaky)[0]})" if bad or flaky else ""), "data": {"parts": parts, "flaky": flaky[:30], "failing": bad[:30], "times": times}}
    return h
