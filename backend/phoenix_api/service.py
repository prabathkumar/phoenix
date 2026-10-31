"""POST /api/pipeline/run: one request runs the whole AI-driven pipeline.
{goal, requirement? | requirementUrl? | requirementFile? | jiraKey?, project?, steps?, web?, mobile?, baseUrl?, appUrl?, testData?, repo?, evaluate?,
 stages?, autonomy?, approvals?, production?} -> {ok, runId, retest, requirement, plan, stages (no data), summary, needsYou}
Needs-you stages come back with their id; send the same request again with approvals:{id:true} to let them run."""
import os

from . import ai_pipeline, analytics, exec_client, gateway, handlers as H, jira as J, prompt_store, repo as R, requirements_loader, run_record, signoff, testdata
from . import llm as _llm


class Deps:
    def __init__(self, env=None, call_json=None, jira=None, fetch=None, fetcher=None, connect_repo=None, run=None, exec_fetch=None, allow_private=False, use_gateway=True):
        self.env = dict(os.environ if env is None else env)
        self.call_json = call_json if call_json is not None else (_llm.ollama_call_json(self.env) if _llm.ollama_configured(self.env) else None)
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
    run_id = run_record.new_id()
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
    call_json = gateway.wrap(deps.call_json, "pipeline", run=run_id, env=env) if deps.call_json and deps.use_gateway else deps.call_json
    get_prompt = lambda n, p="shared": H.library_prompt(n, p, env)  # noqa: E731
    state, failed_cases, values = {}, [], {}
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
        payload = {"runId": run_id, "testData": values, "web": body.get("web"), "mobile": body.get("mobile"), "api": {"steps": [s for s in steps if isinstance(s, dict) and s.get("kind") == "api"], "baseUrl": base_url},
                   "cases": cases if (body.get("web") or body.get("mobile")) else []}
        r = await exec_client.execute(deps.env.get("ENGINE_URL"), payload, deps.exec_fetch)
        if r.get("unavailable"):
            return {"unavailable": True, "detail": r["detail"]}
        for x in r.get("results", []):
            signoff.record_execution(run_id, x["id"], x["result"], "ai", x.get("where", ""), x.get("detail", ""), x.get("ms", 0), url)
        failed_cases.extend(r.get("failedCases", []))
        if r.get("harPath"):
            state["harPath"] = r["harPath"]
        return {"ok": r.get("ok", False), "detail": r.get("detail", ""), "data": {"failedCases": [{"name": c["name"]} for c in r.get("failedCases", [])]}}

    async def har_h(ctx):
        return await H.har_handler()({**ctx, "harPath": state.get("harPath")})

    async def defects_h(ctx):
        return await J.defects_handler(deps.jira, jira_key, list(values.values()))({**ctx, "failedCases": failed_cases})

    hs = {
        "scenarios": H.scenarios_handler(call_json, get_prompt), "cases": H.cases_handler(call_json, get_prompt, project, jira_key or "", run_id, url),
        "testdata": testdata_h, "execution": execution_h, "har": har_h, "performance": H.performance_handler(**run_kw), "dast": H.dast_handler(env=env, **run_kw),
        "traceability": H.traceability_handler(call_json, deps.connect_repo), "aieval": H.aieval_handler(env=env, run_id=run_id, **run_kw),
        "unittests": H.unittests_handler(call_json, get_prompt, deps.connect_repo), "testspr": H.testspr_handler(deps.connect_repo),
        "defects": defects_h, "signoff": H.signoff_handler(run_id, url), "feedback": H.feedback_handler(env.get("PHOENIX_REPORTS_DIR", "logs/reports")),
    }
    ev = body.get("evaluate") if isinstance(body.get("evaluate"), dict) else None
    out = await ai_pipeline.run_ai_pipeline(
        body["goal"], requirement, {"steps": steps, "baseUrl": base_url, "appUrl": body.get("appUrl"), "requirement": requirement, "requirementKey": jira_key, "goal": body["goal"], "ruleset": body.get("ruleset"),
                                    "evaluate": ev, "repoRequest": body.get("repo") if isinstance(body.get("repo"), dict) else None, "testData": body.get("testData") or {}, "env": env},
        hs, autonomy, body.get("approvals") if isinstance(body.get("approvals"), dict) else {}, body.get("production") is True, call_json, deps.run, run_id,
        body.get("stages") if isinstance(body.get("stages"), list) else None, run_record.brief_for(jira_key, url=url))
    rec = run_record.link(out["stages"], jira_key, body["goal"], out["plan"], run_id, retest, source, project)
    try:
        run_record.save(rec, url)
    except Exception:
        pass  # a full disk never fails a run
    clean = [{k: v for k, v in s.items() if k != "data"} for s in out["stages"]]
    return 200, {"ok": out["ok"], "runId": run_id, "retest": retest, "requirement": {**source, "notes": notes, "characters": len(requirement)} if source else None,
                 "plan": {"source": out["plan"]["source"], "platforms": out["plan"]["platforms"], "reason": out["plan"].get("reason")}, "stages": clean, "summary": out["summary"], "needsYou": out["needsYou"]}
