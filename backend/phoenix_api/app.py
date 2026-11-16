"""Phoenix API (FastAPI). React talks to this; this talks to Postgres, ClickHouse, the Node execution engine, Jira, GitHub/GitLab and the model."""
import os

from fastapi import Body, FastAPI, Header, HTTPException, Query
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware

from . import agents, ai_eval, avatars, analytics, dashboard, db, gateway, guardrails, handlers as H, kpi, logstore, mcp_registry, pipeline, training, prompt_store, run_record, signoff
from .service import Deps, run_chain, run_pipeline_request


def create_app(deps: Deps | None = None) -> FastAPI:
    app = FastAPI(title="Phoenix API", version="1.0")
    app.add_middleware(CORSMiddleware, allow_origins=os.environ.get("CORS_ORIGINS", "http://localhost:5173,http://localhost:8091").split(","), allow_methods=["*"], allow_headers=["*"])
    D = deps or Deps()
    url = D.db
    db.engine_for(url)  # connect and create the tables at start-up, not on the first request
    try:
        agents.seed_roster(url)  # the named agent team exists from the first start
    except Exception as e:  # noqa: BLE001 - a roster problem must not stop the API
        print(f"[phoenix-api] could not seed the agent roster: {e}")
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


    # ---- agents (saved AI workers; they run through the same pipeline, gates and sign-off)
    def _agent_err(e):
        return HTTPException(404 if str(e).startswith("No agent") else 400, str(e))

    @app.get("/api/agents")
    def agents_list():
        return {"agents": agents.list_agents(url), "stages": [{"id": s["id"], "name": s["name"]} for s in pipeline.STAGES]}

    @app.get("/api/agents/{name}/avatar.svg")
    def agents_avatar(name: str):
        f = agents.AVATAR_DIR / f"{name}.svg"
        if not agents.NAME_RE.match(name) or not f.is_file():
            raise HTTPException(404, "No logo for that agent.")
        return Response(f.read_text(encoding="utf-8"), media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=3600"})

    @app.get("/api/agents/{name}")
    def agents_get(name: str):
        try:
            return agents.get(name, url)
        except agents.AgentError as e:
            raise _agent_err(e)

    @app.post("/api/agents")
    def agents_create(body: dict = Body(...), x_user: str = Header(default=""), x_source: str = Header(default="ui")):
        try:
            return agents.create(body, body.get("actor") or x_user, "mcp" if x_source == "mcp" else "ui", url)
        except agents.AgentError as e:
            raise _agent_err(e)

    @app.put("/api/agents/{name}")
    def agents_update(name: str, body: dict = Body(...), x_user: str = Header(default=""), x_source: str = Header(default="ui")):
        try:
            return agents.update(name, body, body.get("actor") or x_user, "mcp" if x_source == "mcp" else "ui", url)
        except agents.AgentError as e:
            raise _agent_err(e)

    @app.post("/api/agents/{name}/enabled")
    def agents_enable(name: str, body: dict = Body(...), x_user: str = Header(default="")):
        try:
            return agents.set_enabled(name, body.get("enabled") is True, body.get("actor") or x_user, D.env, url)
        except agents.AgentError as e:
            raise _agent_err(e)

    @app.delete("/api/agents/{name}")
    def agents_delete(name: str, x_user: str = Header(default="")):
        try:
            return agents.delete(name, x_user, url)
        except agents.AgentError as e:
            raise _agent_err(e)

    @app.post("/api/agents/{name}/run")
    async def agents_run(name: str, body: dict = Body(default={})):
        try:
            req = agents.request_for(name, body.get("input"), url)
        except agents.AgentError as e:
            raise _agent_err(e)
        code, out = await run_pipeline_request(req, D)
        if code != 200:
            raise HTTPException(code, out["error"])
        return {**out, "agent": name}


    # ---- avatars: a tester's own identity for calling agents
    def _avatar_err(e):
        return HTTPException(403 if "only" in str(e) else 400, str(e))

    @app.get("/api/avatars/{owner}")
    def avatar_get(owner: str):
        return {"avatar": avatars.get(owner, url)}

    @app.put("/api/avatars/{owner}")
    def avatar_save(owner: str, body: dict = Body(...), x_user: str = Header(default="")):
        try:
            return {"avatar": avatars.save(owner, body, body.get("actor") or x_user, url)}
        except avatars.AvatarError as e:
            raise _avatar_err(e)

    @app.post("/api/avatars/{owner}/call")
    async def avatar_call(owner: str, body: dict = Body(...), x_user: str = Header(default="")):
        try:
            steps = avatars.plan(owner, body.get("agent"), body.get("input"), body.get("actor") or x_user, url)
        except (avatars.AvatarError, agents.AgentError) as e:
            raise _avatar_err(e) if isinstance(e, avatars.AvatarError) else _agent_err(e)
        return await run_chain(steps, D)

    # ---- test cases and sign-off
    @app.get("/api/cases")
    def cases(project: str | None = None, requirement: str | None = None, signoff_state: str | None = Query(None, alias="signoff"), scenario: str | None = None):
        return {"cases": signoff.list_cases(project, requirement, signoff_state, url, scenario)}

    @app.post("/api/cases")
    def upsert(body: dict = Body(...)):
        try:
            return signoff.upsert_case(body["id"], body["title"], body.get("steps"), body.get("project", ""), body.get("requirement", ""), body.get("priority", "Medium"), body.get("who", "human"), url, body.get("scenario", ""))
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

    # ---- logs: one ingest door, reads keyed by project, and the training of the 8B model (people decide)
    def _ingest_ok(token):
        need = D.env.get("PHOENIX_INGEST_TOKEN", "")
        if need and token != need:
            raise HTTPException(401, "Ingest token missing or wrong.")

    @app.post("/api/ingest")
    def ingest(body: dict = Body(...), x_ingest_token: str = Header(default="")):
        _ingest_ok(x_ingest_token)
        events = body.get("events") if isinstance(body.get("events"), list) else [body]
        stored = sum(1 for e in events[:2000] if isinstance(e, dict) and logstore.record(e.get("kind", ""), e.get("row") or {}, D.env))
        return {"stored": stored, "received": min(len(events), 2000), "backend": analytics.default().backend}

    @app.get("/api/logs/{table}")
    def logs_read(table: str, project: str = "", n: int = 100, days: int = 30, agent: str = "", tool: str = "", who: str = "", verdict: str = "", run: str = ""):
        try:
            return {"rows": logstore.read(table, project or None, n, days, {"agent": agent, "tool": tool, "who": who, "verdict": verdict, "run": run}), "backend": analytics.default().backend}
        except ValueError as e:
            raise bad(e)

    @app.get("/api/logs-summary")
    def logs_summary(project: str = "", days: int = 7):
        return {"counts": logstore.summary(project or None, days), "backend": analytics.default().backend, "status": analytics.default().status()}

    @app.post("/api/defects")
    def defect_record(body: dict = Body(...), x_user: str = Header(default="")):
        """A defect found in any phase: unit | integration | system | uat | production. A production defect is a leak; unitTestable=true marks one a unit test should have caught."""
        if body.get("foundIn") not in ("unit", "integration", "system", "uat", "production"):
            raise HTTPException(400, "foundIn is one of unit, integration, system, uat, production.")
        ok = logstore.record("defect", {"project": body.get("project", ""), "run": body.get("run", ""), "dkey": body.get("key", ""), "found_in": body["foundIn"], "severity": body.get("severity", ""),
                                         "unit_testable": 1 if body.get("unitTestable") else 0, "status": body.get("status", "open"), "case_id": body.get("caseId", ""), "source": body.get("source") or (body.get("actor") or x_user or "manual")}, D.env)
        return {"stored": ok}

    @app.get("/api/kpi")
    def kpi_report(project: str = "", days: int = 30):
        return kpi.report(project or None, max(1, min(days, 365)), url, D.env)

    @app.post("/api/training/label")
    def training_label(body: dict = Body(...), x_user: str = Header(default="")):
        """A person marks a captured example good, bad or corrected (with the better answer). Stored as a new row; export keeps the latest label per prompt."""
        who = body.get("actor") or x_user
        if not who:
            raise HTTPException(400, "Labelling needs a signed-in person.")
        if body.get("outcome") not in ("good", "bad", "corrected"):
            raise HTTPException(400, "outcome is good, bad or corrected.")
        if body["outcome"] == "corrected" and not str(body.get("preferred") or "").strip():
            raise HTTPException(400, "A correction needs the better answer.")
        ok = logstore.record("training_example", {"project": body.get("project", ""), "source": body.get("source", "label"), "prompt": body.get("prompt", ""), "response": body.get("response", ""), "outcome": body["outcome"], "preferred": body.get("preferred", "")}, D.env)
        logstore.record("user_action", {"who": who, "action": "label-example", "subject": body["outcome"], "status": "ok" if ok else "capture-off"}, D.env)
        return {"stored": ok}

    @app.get("/api/training/status")
    def training_status(project: str = ""):
        return {"stats": training.stats(project or None, D.env), **training.list_jobs(D.env)}

    @app.post("/api/training/export")
    def training_export(body: dict = Body(default={})):
        return training.export(body.get("project") or None, D.env)

    @app.post("/api/training/jobs")
    def training_start(body: dict = Body(default={}), x_user: str = Header(default="")):
        try:
            return training.start(body.get("project") or None, body.get("actor") or x_user, body.get("base") or "Qwen/Qwen3-8B", int(body.get("epochs") or 2), D.env)
        except ValueError as e:
            raise bad(e)

    @app.get("/api/training/jobs/{job_id}")
    def training_job(job_id: str):
        try:
            return training.get(job_id, D.env)
        except ValueError as e:
            raise HTTPException(404, str(e))

    @app.post("/api/training/jobs/{job_id}/result")
    def training_result(job_id: str, body: dict = Body(...), x_ingest_token: str = Header(default="")):
        _ingest_ok(x_ingest_token)
        try:
            return training.report(job_id, body, D.env)
        except ValueError as e:
            raise HTTPException(404, str(e))

    @app.post("/api/training/jobs/{job_id}/promote")
    def training_promote(job_id: str, body: dict = Body(...), x_user: str = Header(default="")):
        try:
            j = training.promote(job_id, body.get("actor") or x_user, body.get("note", ""), D.env)
        except ValueError as e:
            raise bad(e)
        logstore.record("user_action", {"who": body.get("actor") or x_user, "action": "promote-model", "subject": job_id, "status": "ok"}, D.env)
        return j

    ui = os.environ.get("PHOENIX_UI_DIR")
    if ui and os.path.isdir(ui):
        from fastapi.responses import FileResponse
        from fastapi.staticfiles import StaticFiles
        app.mount("/assets", StaticFiles(directory=os.path.join(ui, "assets")), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            if path.startswith("api/"):
                raise HTTPException(404, "Unknown API route.")
            f = os.path.join(ui, path)
            return FileResponse(f if path and os.path.isfile(f) else os.path.join(ui, "index.html"))

    return app
