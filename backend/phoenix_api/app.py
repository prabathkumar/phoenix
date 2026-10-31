"""Phoenix API (FastAPI). React talks to this; this talks to Postgres, ClickHouse, the Node execution engine, Jira, GitHub/GitLab and the model."""
import os

from fastapi import Body, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from . import ai_eval, analytics, dashboard, db, gateway, guardrails, handlers as H, mcp_registry, pipeline, prompt_store, run_record, signoff
from .service import Deps, run_pipeline_request


def create_app(deps: Deps | None = None) -> FastAPI:
    app = FastAPI(title="Phoenix API", version="1.0")
    app.add_middleware(CORSMiddleware, allow_origins=os.environ.get("CORS_ORIGINS", "http://localhost:5173,http://localhost:8091").split(","), allow_methods=["*"], allow_headers=["*"])
    D = deps or Deps()
    url = D.db
    bad = lambda e: HTTPException(400, str(e))  # noqa: E731

    @app.get("/api/health")
    def health():
        return {"ok": True, "postgres": db.dialect(url), "analytics": analytics.default().status()}

    # ---- pipeline
    @app.get("/api/pipeline/tools")
    def tools():
        return {"tools": H.tool_status(env=D.env), "stages": [{"id": s["id"], "name": s["name"]} for s in pipeline.STAGES]}

    @app.post("/api/pipeline/run")
    async def run(body: dict = Body(...)):
        code, out = await run_pipeline_request(body, D)
        if code != 200:
            raise HTTPException(code, out["error"])
        return out

    @app.post("/api/eval/run")
    async def eval_run(body: dict = Body(...)):
        import asyncio
        r = await asyncio.to_thread(ai_eval.evaluate, body.get("turns"), body.get("conversation"), body.get("metrics"), body.get("threshold", 0.5), body.get("criteria"), env=D.env)
        return r

    # ---- runs
    @app.get("/api/runs")
    def runs():
        return {"runs": run_record.list_runs(50, url)}

    @app.get("/api/runs/{run_id}")
    def one_run(run_id: str):
        try:
            rec = run_record.get(run_id, url)
        except ValueError as e:
            raise bad(e)
        if not rec:
            raise HTTPException(404, "No such run.")
        return {"run": rec, "calls": gateway.read_log(200, run_id), "executions": signoff.executions_for(run_id, url), "checks": signoff.run_checks(run_id, url)}

    # ---- test cases and sign-off
    @app.get("/api/cases")
    def cases(project: str | None = None, requirement: str | None = None, signoff_state: str | None = Query(None, alias="signoff")):
        return {"cases": signoff.list_cases(project, requirement, signoff_state, url)}

    @app.post("/api/cases")
    def upsert(body: dict = Body(...)):
        try:
            return signoff.upsert_case(body["id"], body["title"], body.get("steps"), body.get("project", ""), body.get("requirement", ""), body.get("priority", "Medium"), body.get("who", "human"), url)
        except (KeyError, ValueError) as e:
            raise bad(e)

    @app.post("/api/signoff/case/{case_id}/request")
    def req_case(case_id: str, body: dict = Body(default={}), x_user: str = Header(default="")):
        try:
            return signoff.request_case(case_id, body.get("actor") or x_user, body.get("note", ""), url)
        except signoff.SignoffError as e:
            raise bad(e)

    @app.post("/api/signoff/run/{run_id}/request")
    def req_run(run_id: str, body: dict = Body(default={}), x_user: str = Header(default="")):
        try:
            return signoff.request_run(run_id, body.get("actor") or x_user, body.get("note", ""), url)
        except signoff.SignoffError as e:
            raise bad(e)

    @app.post("/api/signoff/{signoff_id}/decide")
    def decide(signoff_id: int, body: dict = Body(...), x_user: str = Header(default="")):
        try:
            return signoff.decide(signoff_id, body.get("decision"), body.get("actor") or x_user, body.get("note", ""), url, D.env)
        except signoff.SignoffError as e:
            raise bad(e)

    @app.get("/api/signoff")
    def signoffs(kind: str | None = None, status: str | None = None, subject: str | None = None):
        return {"signoffs": signoff.list_signoffs(kind, status, subject, url), "funnel": signoff.funnel(url)}

    @app.post("/api/executions")
    def record_exec(body: dict = Body(...)):
        """A person's result for a case they ran by hand (guided step)."""
        try:
            signoff.record_execution(body["runId"], body["caseId"], body["result"], "human", body.get("where", "manual"), body.get("note", ""), 0, url)
            return {"ok": True}
        except (KeyError, signoff.SignoffError) as e:
            raise bad(e)

    # ---- monitoring dashboard
    @app.get("/api/dashboard")
    def dash(days: int = 14):
        return dashboard.summary(max(1, min(days, 90)), url)

    # ---- gateway
    @app.get("/api/gateway/prompts")
    def prompts():
        return {"prompts": prompt_store.list_prompts(D.env)}

    @app.get("/api/gateway/prompt")
    def prompt(name: str, platform: str = "shared"):
        r = prompt_store.get(name, platform, D.env)
        if not r:
            raise HTTPException(404, "No such prompt.")
        return {"prompt": r}

    @app.post("/api/gateway/prompt")
    def save_prompt(body: dict = Body(...)):
        try:
            return {"prompt": prompt_store.save_version(body["name"], body["text"], body.get("platform", "shared"), body.get("note", ""), body.get("by", ""), body.get("publish", True), env=D.env)}
        except (KeyError, ValueError) as e:
            raise bad(e)

    @app.post("/api/gateway/publish")
    def publish(body: dict = Body(...)):
        try:
            return {"prompt": prompt_store.publish(body["name"], body.get("platform", "shared"), int(body["v"]), D.env)}
        except (KeyError, ValueError) as e:
            raise bad(e)

    @app.post("/api/gateway/settings")
    def settings(body: dict = Body(...)):
        try:
            return {"prompt": prompt_store.set_settings(body["name"], body.get("platform", "shared"), body.get("guardrails"), body.get("mcp"), body.get("models"), D.env)}
        except (KeyError, ValueError) as e:
            raise bad(e)

    @app.post("/api/gateway/import")
    def imp():
        return {"imported": prompt_store.import_registry(env=D.env)}

    @app.get("/api/gateway/guardrails")
    def rules():
        return {"rules": (db.doc_get("guardrails", "all", url) or {}).get("rules") or guardrails.DEFAULT_RULES}

    @app.post("/api/gateway/guardrails")
    def save_rules(body: dict = Body(...)):
        if not isinstance(body.get("rules"), list):
            raise HTTPException(400, "Send rules as a list.")
        try:
            gateway.save_rules(body["rules"], D.env)
        except ValueError as e:
            raise bad(e)
        return {"rules": len(body["rules"])}

    @app.get("/api/gateway/mcp")
    def mcp():
        return {"servers": mcp_registry.list_servers(D.env)}

    @app.post("/api/gateway/mcp/{action}")
    async def mcp_action(action: str, body: dict = Body(...)):
        try:
            if action == "add":
                return {"server": mcp_registry.add(body["id"], body["url"], body.get("headers"), True, D.env)}
            if action == "remove":
                mcp_registry.remove(body["id"], D.env)
                return {"removed": body["id"]}
            if action == "enable":
                mcp_registry.set_enabled(body["id"], body.get("enabled", True) is not False, D.env)
                return {"id": body["id"]}
            if action == "refresh":
                return {"server": await mcp_registry.refresh(body["id"], D.env)}
        except (KeyError, ValueError, RuntimeError) as e:
            raise bad(e)
        raise HTTPException(404, "Unknown MCP action.")

    @app.get("/api/gateway/logs")
    def logs(n: int = 100, run: str | None = None):
        rows = gateway.read_log(min(n, 500), run)
        return {"calls": [{**r, "at": r["at"].isoformat() if hasattr(r["at"], "isoformat") else r["at"]} for r in rows], "source": analytics.default().backend}

    @app.post("/api/gateway/test")
    async def test_prompt(body: dict = Body(...)):
        providers = {"ollama": D.call_json} if D.call_json else {}
        try:
            return await gateway.call_prompt(body["name"], body.get("platform", "shared"), body.get("vars") or {}, body.get("input", ""), providers, list(providers), env=D.env)
        except (KeyError, ValueError) as e:
            raise bad(e)

    return app


