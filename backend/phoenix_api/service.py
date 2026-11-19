"""POST /api/pipeline/run: one request runs the whole AI-driven pipeline.
{goal, requirement? | requirementUrl? | requirementFile? | jiraKey?, project?, steps?, web?, mobile?, baseUrl?, appUrl?, testData?, repo?, evaluate?,
 stages?, autonomy?, approvals?, production?} -> {ok, runId, retest, requirement, plan, stages (no data), summary, needsYou}
Needs-you stages come back with their id; send the same request again with approvals:{id:true} to let them run."""
import json
import os

from . import pipeline as pipeline_mod
from . import unit_cases
from . import ai_pipeline, analytics, exec_client, gateway, handlers as H, jira as J, prompt_store, repo as R, requirements_loader, run_record, signoff, testdata
from . import llm as _llm


class Deps:
    def __init__(self, env=None, call_json=None, jira=None, fetch=None, fetcher=None, connect_repo=None, run=None, exec_fetch=None, allow_private=False, use_gateway=True):
        self.env = dict(os.environ if env is None else env)
        self.call_json = call_json if call_json is not None else _llm.call_json_from_env(self.env)
        self.jira = jira or J.Jira(self.env, **({"fetch": fetch} if fetch else {}))
        self.fetcher = fetcher or requirements_loader.fetch_public
        self.connect_repo = connect_repo or (lambda rq: R.from_env(rq.get("provider", "github"), rq.get("project"), self.env, rq.get("baseUrl"), **({"fetch": fetch} if fetch else {})))
        self.run, self.exec_fetch, self.allow_private, self.use_gateway = run, exec_fetch, allow_private, use_gateway

    @property
    def db(self):
        return self.env.get("DATABASE_URL")


async def run_pipeline_request(body, deps: Deps):
    if not str(body.get("goal") or "").strip():
        return 400, {"error": "Say what to test (goal)."}
    env, url = deps.env, deps.db
    autonomy = body.get("autonomy") if body.get("autonomy") in ("ask-everything", "ask-when-matters", "run-everything") else "ask-when-matters"
    requirement, source, notes = body.get("requirement") if isinstance(body.get("requirement"), str) else "", None, []
    if requirement:
        source = {"kind": "text"}
    if not requirement and (body.get("requirementUrl") or body.get("requirementFile")):
        try:
            rq = await requirements_loader.load_requirement(url=body.get("requirementUrl"), file=body.get("requirementFile"), jira=deps.jira, allow_private=deps.allow_private, fetcher=deps.fetcher)
            requirement, source, notes = rq["text"], rq["source"], rq["notes"]
        except Exception as e:
            return 400, {"error": str(e)}
    jira_key = body.get("jiraKey")
    if not requirement and jira_key:
        try:
            requirement = (await J.read_requirement(deps.jira, str(jira_key)))["text"]
            source = {"kind": "jira", "name": str(jira_key)}
        except Exception as e:
            return 400, {"error": str(e)}
    run_id = body.get("_run_id") if run_record.ok_id(body.get("_run_id")) else run_record.new_id()
    prior = run_record.prior_for(jira_key, url=url)
    retest = []
    if prior and not deps.jira.missing:
        try:
            retest = [x["key"] for x in await J.defects_to_retest(deps.jira, list(dict.fromkeys(k for r in prior for k in r["defects"]["keys"])))]
        except Exception:
            pass
    brief = run_record.brief_for(jira_key, url=url)
    if brief or retest:
        requirement += "\n\nEarlier runs of this requirement:\n" + "\n".join(brief) + (f"\nFixed in Jira, re-test their cases: {', '.join(retest)}" if retest else "")

    steps = body.get("steps") if isinstance(body.get("steps"), list) else []
    base_url = body["baseUrl"] if isinstance(body.get("baseUrl"), str) and body["baseUrl"].lower().startswith(("http://", "https://")) else None
    project = str(body.get("project") or "")
    call_json = gateway.wrap(deps.call_json, "pipeline", run=run_id, env=env, model_name=_llm.provider(env) or "model") if deps.call_json and deps.use_gateway else deps.call_json
    get_prompt = lambda n, p="shared": H.library_prompt(n, p, env)  # noqa: E731
    state, failed_cases, values = {}, [], {}
    who = f"avatar:{body['avatar']}" if body.get("avatar") else "ai"  # work done through a tester's avatar is theirs
    run_kw = {"run": deps.run} if deps.run else {}

    async def testdata_h(ctx):
        names = testdata.required_names(steps + [body.get("web"), body.get("mobile")])
        plan = testdata.plan_test_data(names, body.get("testData") or {}, "pipeline", env)
        values.update(plan["values"])
        if plan["needs_you"]:
            return {"ok": False, "detail": f"needs you: {', '.join(plan['needs_you'])}", "data": {"names": names}}
        return {"ok": True, "detail": f"{len(plan['fields'])} field(s) ready", "data": {"names": names}}

    async def execution_h(ctx):
        cases = []
        gen = next((s for s in ctx.get("results", []) if s["id"] == "cases"), {}).get("data") or {}
        for c in gen.get("items", []):
            if isinstance(c, dict) and c.get("id") and isinstance(c.get("steps"), list) and c["steps"]:
                cases.append({"id": c["id"], "name": c.get("title") or c.get("name") or c["id"], "platform": (c.get("platform") or ((ctx.get("platforms") or ["web"])[0] if (ctx.get("platforms") or ["web"])[0] != "api" else "web")), "steps": "\n".join(map(str, c["steps"]))})
        picked = {c.get("id") for c in body.get("cases", []) if isinstance(c, dict)}
        plat = (ctx.get("platforms") or ["web"])[0]
        everyone = signoff.list_cases(url=url)
        for sc in body.get("scenarios") or []:  # "run this scenario": every case in it, always
            picked |= {c["id"] for c in everyone if c.get("scenario") == str(sc)}
        # picking some cases of a scenario is allowed only on purpose: say how many would not run
        partial = []
        for sc in sorted({c["scenario"] for c in everyone if c["id"] in picked and c.get("scenario")}):
            mine = [c for c in everyone if c.get("scenario") == sc]
            left = [c for c in mine if c["id"] not in picked]
            if left:
                partial.append({"scenario": sc, "total": len(mine), "picked": len(mine) - len(left), "notRun": [c["id"] for c in left]})
        if partial and body.get("allowPartial") is not True:
            w = "; ".join(f"{p['picked']} of {p['total']} in '{p['scenario']}'" for p in partial)
            return {"ok": False, "detail": f"needs you: only part of a scenario was picked ({w}). Run the whole scenario, or confirm a partial suite.", "data": {"partial": partial}}
        for c in everyone:  # cases a person selected in the UI: run exactly those, by id
            if c["id"] in picked and c["steps"]:
                cases.append({"id": c["id"], "name": c["title"], "platform": "mobile" if plat == "mobile" else "web", "steps": "\n".join(map(str, c["steps"]))})
        names = testdata.required_names([c["steps"] for c in cases] + [body.get("web"), body.get("mobile")] + steps)
        plan = testdata.plan_test_data(names, body.get("testData") or {}, "pipeline", env)
        if plan["needs_you"]:
            return {"ok": False, "detail": f"needs you: {', '.join(plan['needs_you'])} (logins that already exist cannot be made up)", "data": {"names": names}}
        values.update(plan["values"])
        payload = {"runId": run_id, "testData": values, "web": body.get("web"), "mobile": body.get("mobile"), "api": {"steps": [s for s in steps if isinstance(s, dict) and s.get("kind") == "api"], "baseUrl": base_url},
                   "cases": cases if (body.get("web") or body.get("mobile")) else []}
        r = await exec_client.execute(deps.env.get("ENGINE_URL"), payload, deps.exec_fetch)
        if r.get("unavailable"):
            return {"unavailable": True, "detail": r["detail"]}
        for x in r.get("results", []):
            signoff.record_execution(run_id, x["id"], x["result"], who, x.get("where", ""), x.get("detail", ""), x.get("ms", 0), url)
        for p in partial:  # the cases left out are recorded as skipped, so nobody can mistake a partial suite for a full one
            for cid in p["notRun"]:
                signoff.record_execution(run_id, cid, "skipped", who, "", f"left out of a partial suite ({p['picked']} of {p['total']} in '{p['scenario']}')", 0, url)
        failed_cases.extend(r.get("failedCases", []))
        try:
            from . import notify as _n
            for c in r.get("failedCases", []):
                _n.collect("execution-failed", project or "", c.get("name", ""), env)       # counted, then sent as one digest, never one message each
        except Exception:  # noqa: BLE001
            pass
        if r.get("harPath"):
            state["harPath"] = r["harPath"]
        return {"ok": r.get("ok", False), "detail": r.get("detail", ""), "data": {"failedCases": [{"name": c["name"]} for c in r.get("failedCases", [])], "partial": partial}}

    async def har_h(ctx):
        return await H.har_handler()({**ctx, "harPath": state.get("harPath")})

    async def defects_h(ctx):
        items = failed_cases + findings_as_defects(ctx.get("results", []))
        if body.get("defectMode") == "single" and items:  # one bug for everything this run found; the next run comments on it instead of opening another
            items = [consolidate(items, str(body.get("release") or project or jira_key or run_id), run_id)]
        r = await J.defects_handler(deps.jira, jira_key, list(values.values()))({**ctx, "failedCases": items})
        try:  # each defect the run found goes to the defect log (found in the system test phase), for leakage and detection numbers
            from . import logstore
            from . import notify as _n
            for m in (r.get("data") or {}).get("defects", []):
                _n.collect("defect-raised", project or "", m.get("key", ""), env)
                logstore.record("defect", {"project": project, "run": run_id, "dkey": m.get("key", ""), "found_in": "system", "severity": m.get("severity", ""), "status": "open", "source": "pipeline"}, env)
        except Exception:  # noqa: BLE001
            pass
        return r

    def scan_repo(stage):
        """Secrets and SAST need the code. Without a linked repo they say so (they never scan the server's own folder); with one, the files are
        fetched through the repo API into a private temporary folder, scanned there, and the folder is deleted."""
        inner = pipeline_mod.builtins(deps.run or pipeline_mod._default_run)[stage]

        async def h(ctx):
            rq = ctx.get("repoRequest")
            if not rq or not rq.get("project"):
                return {"unavailable": True, "detail": "no code repo linked: give repo {provider, project} to scan the code"}
            try:
                repo = deps.connect_repo(rq)
            except Exception as e:  # noqa: BLE001
                return {"unavailable": True, "detail": str(e)}
            import shutil
            import tempfile
            tmp = tempfile.mkdtemp(prefix="phoenix-scan-")
            try:
                ref = rq.get("head") or rq.get("ref") or await repo.default_branch()
                total = 0
                for f in (await repo.list_files(ref))[:2000]:
                    if f.startswith("/") or ".." in f.split("/"):
                        continue
                    text = await repo.read_file(f, ref)
                    if not isinstance(text, str) or len(text) > 1_000_000 or total + len(text) > 50_000_000:
                        continue
                    total += len(text)
                    dest = os.path.join(tmp, f)
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                    with open(dest, "w", encoding="utf-8") as fh:
                        fh.write(text)
                return await inner({**ctx, "dir": tmp})
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
        return h

    hs = {
        "scenarios": H.scenarios_handler(call_json, get_prompt), "cases": H.cases_handler(call_json, get_prompt, project, jira_key or "", run_id, url, str(body.get("goal") or "")[:120]),
        "secrets": scan_repo("secrets"), "sast": scan_repo("sast"), "testdata": testdata_h, "execution": execution_h, "har": har_h, "performance": H.performance_handler(**run_kw), "dast": H.dast_handler(env=env, **run_kw),
        "traceability": H.traceability_handler(call_json, deps.connect_repo), "aieval": H.aieval_handler(env=env, run_id=run_id, **run_kw),
        "unittests": H.unittests_handler(call_json, get_prompt, deps.connect_repo), "unitrun": H.unitrun_handler(project, run_id, env), "testspr": H.testspr_handler(deps.connect_repo),
        "defects": defects_h, "signoff": H.signoff_handler(run_id, url, str(body.get("onBehalfOf") or "Phoenix AI")), "feedback": H.feedback_handler(env.get("PHOENIX_REPORTS_DIR", "logs/reports"), project or "", run_id), "measure": H.measure_handler(project or "", url, env),
        "apitests": H.apifunc_handler(deps.connect_repo, env=env), "repolink": H.repolink_handler(deps.connect_repo), "deployed": H.deployed_handler(), "evidence": H.evidence_handler(project or "", run_id, env), "revalidate": H.revalidate_handler(deps.connect_repo, env=env),
    }
    unit_inner = hs["unittests"]

    async def unittests_h(ctx):
        r = await unit_inner(ctx)
        tests = ((r or {}).get("data") or {}).get("tests") or []
        if r and r.get("ok") and tests:  # created in TestOps first, then pushed to Jira (a Jira write: needs the same approval as defects)
            allowed = bool((body.get("approvals") or {}).get("defects"))
            r["data"]["registered"] = await unit_cases.register([{k: t.get(k) for k in ("path", "language", "flagged")} for t in tests], project or "", jira_key or "", deps.jira, allowed, url, env)
            r["detail"] += f"; {len(r['data']['registered'])} created in TestOps" + (f", {sum(1 for x in r['data']['registered'] if x.get('jira'))} in Jira" if allowed else "")
        return r
    hs["unittests"] = unittests_h
    ev = body.get("evaluate") if isinstance(body.get("evaluate"), dict) else None
    out = await ai_pipeline.run_ai_pipeline(
        body["goal"], requirement, {"steps": steps, "baseUrl": base_url, "appUrl": body.get("appUrl"), "requirement": requirement, "requirementKey": jira_key, "goal": body["goal"], "ruleset": body.get("ruleset"), "project": project or "", "apiBaseUrl": body.get("apiBaseUrl") or base_url, "run": run_id,
                                    "evaluate": ev, "repoRequest": body.get("repo") if isinstance(body.get("repo"), dict) else None, "testData": body.get("testData") or {}, "env": env},
        hs, autonomy, body.get("approvals") if isinstance(body.get("approvals"), dict) else {}, body.get("production") is True, call_json, deps.run, run_id,
        body.get("stages") if isinstance(body.get("stages"), list) else None, run_record.brief_for(jira_key, url=url))
    rec = run_record.link(out["stages"], jira_key, body["goal"], out["plan"], run_id, retest, source, project)
    if body.get("agent"):
        rec["agent"] = str(body["agent"])[:40]  # which saved agent ran this
    if body.get("release"):
        rec["release"] = str(body["release"])[:60]
    if body.get("avatar"):
        rec["avatar"] = str(body["avatar"])[:60]
    try:
        run_record.save(rec, url)
    except Exception:
        pass  # a full disk never fails a run
    try:  # a finished (or waiting) run goes to the phone: the TestOps mobile app and WhatsApp, when they are set up
        from . import notify
        if notify.channels(env):
            sm = out["summary"]
            await notify.send("needs-you" if out["needsYou"] else "run-result", f"Run {'needs you' if out['needsYou'] else 'passed' if out['ok'] else 'failed'}: {str(body['goal'])[:60]}",
                              f"{sm['passed']} passed, {sm['failed']} failed" + (f", waiting on {', '.join(out['needsYou'])}" if out["needsYou"] else ""), env, project or "",
                              to=[w for w in [str(body.get("onBehalfOf") or "")] if "@" in w])           # the person who started it hears first
    except Exception:  # noqa: BLE001  a phone that is off never fails a run
        pass
    clean = [{k: v for k, v in s.items() if k != "data"} for s in out["stages"]]
    return 200, {"ok": out["ok"], "runId": run_id, "retest": retest, "requirement": {**source, "notes": notes, "characters": len(requirement)} if source else None,
                 "plan": {"source": out["plan"]["source"], "platforms": out["plan"]["platforms"], "reason": out["plan"].get("reason")}, "stages": clean, "summary": out["summary"], "needsYou": out["needsYou"], **({"artifacts": _artifacts(out["stages"])} if body.get("_artifacts") else {})}


def findings_as_defects(results):
    """Failed unit tests, Semgrep findings, a leak found by the secrets scan and high ZAP alerts, written as defect drafts for Jira. Each has a stable id, so a
    run that finds the same problem again comments on the open defect instead of making a second one. Secret values are never copied: the scan redacts them
    and only the fact and the files go into the defect."""
    import hashlib
    st = {r["id"]: r for r in results}
    d = lambda i: (st.get(i) or {}).get("data") or {}  # noqa: E731
    safe = lambda t: hashlib.sha1(str(t).encode()).hexdigest()[:10]  # noqa: E731
    out = []
    for f in d("unitrun").get("failures", []):
        out.append({"id": f"unit-{safe(f['language'] + f['name'])}", "name": f"Unit test failed: {f['name'][:150]}", "error": f"{f['language']} {f['kind']} test failed", "steps": [f"Requirement: {f['requirement']}"] if f.get("requirement") else []})
    if (st.get("sast") or {}).get("status") == "failed":
        for file, msgs in list((d("sast").get("findings") or {}).items())[:20]:
            out.append({"id": f"sast-{safe(file)}", "name": f"Semgrep finding in {file}", "error": "; ".join(msgs[:3])[:600], "steps": []})
    if (st.get("secrets") or {}).get("status") == "failed":
        out.append({"id": "secrets-found", "name": "Secrets or keys found in the code", "error": "The secrets scan (Gitleaks) reported leaks in the repo. Values are redacted; see the scan report on the Phoenix server and rotate anything real.", "steps": []})
    hi = ((st.get("dast") or {}).get("data") or {}).get("alerts") or {}
    if (st.get("dast") or {}).get("status") == "failed" and hi.get("high"):
        out.append({"id": "dast-high-alerts", "name": f"Security test found {hi['high']} high alert(s)", "error": (st["dast"].get("detail") or "")[:300], "steps": []})
    return out


def consolidate(items, label, run_id=""):
    import hashlib
    lines = [f"{x.get('name') or x.get('id')}: {x.get('error') or x.get('step') or ''}".strip(": ")[:300] for x in items][:60]
    return {"id": "release-" + hashlib.sha1(str(label).encode()).hexdigest()[:10], "name": f"Phoenix found {len(items)} problem(s) in {label}", "error": f"{len(items)} problem(s) found (run {run_id[-6:]}). One bug for all of them.", "steps": lines}


def _artifacts(stages, cap=200_000):
    """What a run created, for the caller: scenarios, cases, the NAMES of test data fields (never values), unit-test and API-test files. Cut at `cap` characters."""
    d = lambda i: next((s for s in stages if s["id"] == i), {}).get("data") or {}  # noqa: E731
    a = {"scenarios": d("scenarios").get("items", []), "cases": d("cases").get("items", []), "testDataFields": d("testdata").get("names", []),
         "unitTests": d("unittests").get("tests", []), "unitCases": d("unittests").get("registered", []), "apiCases": d("apitests").get("cases", []), "pullRequest": d("testspr").get("pr") or d("testspr").get("url")}
    a = {k: v for k, v in a.items() if v}
    if len(json.dumps(a, default=str)) > cap:
        a = {**{k: v for k, v in a.items() if k not in ("unitTests",)}, "unitTests": [{k: v for k, v in t.items() if k != "content"} for t in a.get("unitTests", []) if isinstance(t, dict)], "truncated": True}
    return a


async def run_chain(steps, deps: Deps):
    """Runs linked agents one after another. Each step hands the next the scenarios it just wrote (so the next agent runs the WHOLE batch),
    stops at the first step that needs a person or fails, and says exactly where it stopped. Approvals the caller gave apply to every step."""
    done, handoff = [], []
    for n, body in enumerate(steps):
        body = {k: v for k, v in body.items() if k != "_platform"}
        if handoff and not body.get("cases") and not body.get("scenarios"):
            body["scenarios"] = handoff
        code, out = await run_pipeline_request(body, deps)
        entry = {"agent": body.get("agent"), "ok": code == 200 and bool(out.get("ok")), "runId": out.get("runId") if code == 200 else None, "needsYou": out.get("needsYou", []) if code == 200 else [], "error": out.get("error") if code != 200 else None}
        done.append(entry)
        if not entry["ok"]:
            why = entry["error"] or (f"needs you at {', '.join(entry['needsYou'])}" if entry["needsYou"] else "a stage failed")
            return {"ok": False, "chain": done, "stoppedAt": body.get("agent"), "detail": f"stopped at {body.get('agent')} ({n + 1} of {len(steps)}): {why}", "runId": entry["runId"] or (done[-2]["runId"] if len(done) > 1 else None)}
        more = signoff.scenarios_of_run(out["runId"], deps.db)
        handoff = more or handoff  # an agent that wrote no cases leaves the previous batch in place for the next one
    return {"ok": True, "chain": done, "detail": f"{len(done)} agent(s) ran: {', '.join(d['agent'] for d in done)}", "runId": done[-1]["runId"]}
