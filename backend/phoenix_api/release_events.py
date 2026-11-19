"""Outside callers (ILMU Code, CI) send EVENTS: an agent plus an action, with the release and the input.
  POST /api/v1/events {agent, action, release, requirement|requirementUrl|jiraKey, repo, appUrl, testData, scenarios, task, approvals, callbackUrl}
The saved agents are the base: an event runs that agent's own request through the same pipeline, gates, approvals and sign-off. An action can
only NARROW an agent to some of its stages; it can never add a stage the agent does not have, lower its autonomy, or switch it on.
agent "team" + action "release" runs the whole roster in order. The call returns at once (202); status, artifacts and a signed callback follow."""
import asyncio
import hashlib
import hmac
import json
import os
import re
import secrets
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
from fastapi import Body, Header, HTTPException
from fastapi.responses import JSONResponse

import copy

from . import agents, api_keys, db, registry, release_checks, requirements_loader, run_record, signoff
from .service import run_pipeline_request

KIND = "event"
ID = re.compile(r"^evt-\d{14}-[0-9a-f]{6}$")
# action -> stages of that agent (always intersected with the agent's own stages)
ACTIONS = {
    "scout": {"write-scenarios": ["scenarios"]},
    "scribe": {"write-cases": ["cases"]},
    "mint": {"make-test-data": ["testdata"]},
    "runner": {"execute": ["execution"]},
    "tracer": {"capture-har": ["har"]},
    "pacer": {"performance-test": ["performance"]},
    "warden": {"scan": ["secrets", "sast"], "secrets": ["secrets"], "sast": ["sast"], "scan-secrets": ["secrets"], "scan-code": ["sast"], "trace-requirements": ["traceability"], "revalidate": ["revalidate"]},
    "prowler": {"dast": ["deployed", "dast"], "check-deployment": ["deployed"], "security-test": ["deployed", "dast"]},
    "judge": {"evaluate-ai": ["aieval"]},
    "forge": {"link-repo": ["repolink"], "write-unit-tests": ["unittests"], "run-unit-tests": ["unitrun"], "open-tests-pr": ["unittests", "testspr"], "api-tests": ["apitests"]},
    "herald": {"raise-defects": ["defects"], "request-signoff": ["signoff"]},
    "mentor": {"feedback": ["feedback"], "evidence": ["evidence"]},
    "measure": {"measure": ["measure"], "confirm": ["confirm"]},
}
TEAM = ["scout", "scribe", "mint", "forge", "runner", "tracer", "pacer", "warden", "prowler", "judge", "herald", "mentor", "measure"]
INPUT = ("requirement", "requirementUrl", "jiraKey", "jira", "web", "mobile", "testData", "cases", "scenarios", "allowPartial", "repo", "evaluate", "ruleset", "approvals", "task", "appUrl", "project", "retest", "defectMode")
_tasks, _sem = set(), {}


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def plan(agent, action, url=None):
    """[(agent, stages-or-None)] for an event; raises ValueError with a plain message for anything not allowed."""
    agent, action = str(agent or "").lower(), str(action or "").lower()
    if agent == "team":
        if action != "release":
            raise ValueError('The team only does the action "release".')
        return [(a, None) for a in TEAM]
    if agent not in ACTIONS:
        raise ValueError(f"Unknown agent. Use one of: {', '.join(['team'] + sorted(ACTIONS))}.")
    if action == "run":
        return [(agent, None)]
    if action not in ACTIONS[agent]:
        raise ValueError(f'Agent {agent} does not do "{action}". It does: run, {", ".join(ACTIONS[agent])}.')
    return [(agent, ACTIONS[agent][action])]


def plan_many(items):
    """Several agents together, in the caller's order: [{agent, action}]. Up to 13, no repeats."""
    if not isinstance(items, list) or not items or len(items) > len(TEAM):
        raise ValueError(f"steps is a list of 1 to {len(TEAM)} items like {{agent, action}}.")
    out, seen = [], set()
    for it in items:
        if not isinstance(it, dict):
            raise ValueError("Each step is {agent, action}.")
        for a, st in plan(it.get("agent"), it.get("action") or "run"):
            if (a, tuple(st or ())) in seen:
                raise ValueError(f"{a} appears twice with the same action.")
            seen.add((a, tuple(st or ())))
            out.append((a, st))
    return out


def _agent_stages(name, url):
    try:
        return agents.get(name, url)["stages"]
    except agents.AgentError:
        return []


def catalog():
    return {"agents": {a: ["run"] + list(m) for a, m in ACTIONS.items()}, "team": {"release": TEAM}}


def _safe_callback(u, allow_private):
    p = urlparse(str(u or ""))
    if p.scheme not in ("https", "http") or not p.hostname or p.username or p.password:
        raise ValueError("callbackUrl must be an http(s) address without a username or password.")
    if p.scheme == "http" and not allow_private:
        raise ValueError("callbackUrl must be https.")
    return p


async def _deliver(url, payload, env, allow_private):
    """Signed POST (X-Phoenix-Signature: sha256=HMAC of the body). Public addresses only unless allowed; no redirects; 3 tries."""
    secret = env.get("PHOENIX_WEBHOOK_SECRET", "")
    if not secret:
        return "not sent: PHOENIX_WEBHOOK_SECRET is not set"
    body = json.dumps(payload, default=str).encode()
    sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    last = ""
    for n in range(3):
        try:
            p = _safe_callback(url, allow_private)
            ips = await requirements_loader._resolve(p.hostname)
            if not allow_private and (not ips or any(requirements_loader.private_address(i) for i in ips)):
                return "not sent: the callback address is on a private network"
            async with httpx.AsyncClient(timeout=10, follow_redirects=False) as c:
                r = await c.post(url, content=body, headers={"Content-Type": "application/json", "X-Phoenix-Signature": sig, "X-Phoenix-Event": payload["status"]})
            if r.status_code < 300:
                return "delivered"
            last = f"HTTP {r.status_code}"
        except Exception as e:  # noqa: BLE001
            last = str(e)[:120]
        await asyncio.sleep(1 + n * 2)
    return f"failed: {last}"


def _save(rec, url):
    db.doc_put(KIND, rec["id"], rec, url)


def _summary(rec):
    return {k: rec[k] for k in ("id", "release", "project", "jiraProject", "agent", "action", "caller", "status", "createdAt", "finishedAt", "steps", "needsYou", "callback", "detail", "flags", "warnings") if k in rec}


async def _execute(rec, steps, deps, inp, start=0):
    url = deps.db
    handoff = next((h for h in (signoff.scenarios_of_run(x['runId'], url) for x in reversed(rec['steps'][:start]) if x.get('runId')) if h), [])
    async with _sem.setdefault("s", asyncio.Semaphore(int(deps.env.get("PHOENIX_API_MAX_RUNS", "2") or 2))):
        rec["status"] = "running"
        _save(rec, url)
        for n in range(start, len(steps)):
            name, stages = steps[n]
            st = rec["steps"][n]
            given = {k: inp[k] for k in INPUT if k in inp}
            given.setdefault("defectMode", "single")                                                 # one bug for all findings unless the caller asks for each
            if str(deps.env.get("PHOENIX_API_AUTO_DEFECTS", "true")).lower() != "false":   # the owner's setting, not the caller's: defects found by an event go to Jira without a person clicking
                given["approvals"] = {**(given.get("approvals") or {}), "defects": True}
            try:
                req = agents.request_for(name, given, url)
            except agents.AgentError as e:
                st.update(status="skipped", detail=str(e))  # a switched-off agent is skipped, never switched on from here
                continue
            if stages:
                req["stages"] = [s for s in req["stages"] if s in stages]
            if handoff and not req.get("cases") and not req.get("scenarios"):
                req["scenarios"] = handoff
            req.pop("_platform", None)
            req.update({"release": rec["release"] or None, "_run_id": st.get("runId") or run_record.new_id(), "_artifacts": True, "onBehalfOf": rec["caller"]})
            st.update(status="running", runId=req["_run_id"])
            _save(rec, url)
            try:
                code, out = await run_pipeline_request(req, deps)
            except Exception as e:  # noqa: BLE001
                st.update(status="failed", detail=str(e)[:200])
                continue
            if code != 200:
                st.update(status="failed", detail=str(out.get("error"))[:200])
                continue
            art, flags = release_checks.check_output(out.get("artifacts", {}), deps.env)
            if flags:
                rec["flags"] = list(dict.fromkeys(rec.get("flags", []) + [f"{name}: {f}" for f in flags]))[:50]
            st.update(status="needs-you" if out["needsYou"] else "passed" if out["ok"] else "failed", needsYou=out["needsYou"], summary=out["summary"], artifacts=art, flags=flags,
                      detail=", ".join(f"{s['id']}={s['status']}" for s in out["stages"] if s["status"] != "skipped")[:300])
            handoff = signoff.scenarios_of_run(req["_run_id"], url) or handoff
            if out["needsYou"]:  # a person has to decide: stop here, resume later with approvals
                rec.update(status="needs-you", needsYou=out["needsYou"], resumeAt=n)
                break
            _save(rec, url)
        else:
            bad = [s for s in rec["steps"] if s["status"] in ("failed",)]
            rec["status"] = "failed" if bad else "passed"
            rec.pop("needsYou", None)
        rec["finishedAt"] = _now() if rec["status"] != "needs-you" else rec.get("finishedAt")
        _save(rec, url)
    if rec.get("callbackUrl"):
        rec["callback"] = await _deliver(rec["callbackUrl"], {"eventId": rec["id"], "release": rec["release"], "status": rec["status"], "needsYou": rec.get("needsYou", []), "steps": [{k: v for k, v in s.items() if k != "artifacts"} for s in rec["steps"]]}, deps.env, deps.allow_private)
        _save(rec, url)


def _deps_for(D, jira_project):
    """The event's own copy of the settings, with Jira pointed at the project's Jira project, so defects and requirements go to the right place."""
    d = copy.copy(D)
    d.jira = copy.copy(D.jira)
    if jira_project:
        d.jira.project = jira_project
    return d


def _spawn(coro):
    t = asyncio.create_task(coro)
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)


def mount(app, D):
    url = D.db

    def who(authorization: str = Header(default=""), x_api_key: str = Header(default="")):
        if not api_keys.parse(D.env):
            raise HTTPException(503, "The outside API is not set up: no PHOENIX_API_KEYS on the server.")
        c = api_keys.caller(D.env, authorization, x_api_key)
        if not c:
            raise HTTPException(401, "Missing or wrong API key.")
        return c

    def mine(eid, c):
        if not ID.match(eid):
            raise HTTPException(404, "No such event.")
        rec = db.doc_get(KIND, eid, url)
        if not rec or (rec["caller"] != c and not api_keys.can_approve(D.env, c)):
            raise HTTPException(404, "No such event.")
        if rec["status"] in ("queued", "running") and not any(not t.done() for t in _tasks):
            rec.update(status="interrupted", detail="the server restarted while this ran; send the event again")
            _save(rec, url)
        return rec

    @app.get("/api/v1/actions")
    def actions(authorization: str = Header(default=""), x_api_key: str = Header(default="")):
        who(authorization, x_api_key)
        return catalog()

    @app.post("/api/v1/events", status_code=202)
    async def event(body: dict = Body(...), authorization: str = Header(default=""), x_api_key: str = Header(default="")):
        c = who(authorization, x_api_key)
        def ask(code, msg):
            """The caller is told what to do next, with what exists, so an AI caller can fix the call itself."""
            ps = [{"id": p["id"], "name": p["name"], "jiraProjectKey": p["jiraProjectKey"]} for p in sorted(db.doc_list(registry.PROJECT, url), key=lambda p: p["id"])][:50]
            rs = [{"number": r["number"], "project": r["project"]} for r in db.doc_list(registry.RELEASE, url) if r["status"] == "open"][:50]
            return JSONResponse(status_code=code, content={"detail": msg, "next": ["Give an existing release number (release), or the project id or name (project).", "Or ask the Head of QA to generate the release number in Phoenix, then send it.", "Do not invent a release number: it must be registered."], "projects": ps, "openReleases": rs})
        note = await registry.sync_from_testops(body.get("project"), D.env, url)
        if note:
            return ask(422, note)
        try:
            reg = registry.resolve(str(body.get("release") or "").strip() or None, body.get("project"), url)
        except LookupError as e:
            return ask(404, str(e))
        except PermissionError as e:
            return ask(409, str(e))
        except ValueError as e:
            return ask(400, str(e))
        if str(D.env.get("PHOENIX_API_REQUIRE_JIRA", "true")).lower() != "false" and not (body.get("jiraKey") or reg["jiraKey"]):
            return ask(400, f"This project is linked to Jira ({reg['project']['jiraProjectKey']}): give the Jira id of the requirement or story as jiraKey, like {reg['project']['jiraProjectKey']}-123.")
        if (body.get("jiraKey") or reg["jiraKey"]) and not D.jira.missing:  # Jira is connected: the issue must exist
            key = body.get("jiraKey") or reg["jiraKey"]
            try:
                await D.jira.call("GET", f"/rest/api/3/issue/{key}?fields=summary")
            except Exception as e:  # noqa: BLE001
                return ask(422, f"Jira does not have {key}: {str(e)[:120]}")
        release = reg["release"]["number"] if reg["release"] else ""
        jk = str(body.get("jiraKey") or "").upper()
        if jk and not jk.startswith(reg["project"]["jiraProjectKey"] + "-"):
            raise HTTPException(400, f"jiraKey must be an issue of this project's Jira project ({reg['project']['jiraProjectKey']}-nnn).")
        body = {**body, "project": reg["project"]["id"], **({"jiraKey": jk} if jk else ({"jiraKey": reg["jiraKey"]} if reg["jiraKey"] else {}))}
        try:
            steps = plan_many(body["steps"]) if "steps" in body else plan(body.get("agent"), body.get("action"), url)
            warnings = release_checks.check_input(body, D.env)
            if body.get("callbackUrl"):
                _safe_callback(body["callbackUrl"], D.allow_private)
        except ValueError as e:
            raise HTTPException(400, str(e))
        wanted = {st for a, ss in steps for st in (ss or _agent_stages(a, url))}
        if wanted & {"unittests", "testspr", "unitrun"} and not (body.get("requirement") or body.get("requirementUrl") or body.get("jiraKey")):
            raise HTTPException(400, "Unit tests are written from the requirement and the code changes, so give requirement, requirementUrl or jiraKey with them.")
        if body.get("repo") and wanted & {"repolink", "secrets", "sast", "unittests", "testspr", "unitrun", "apitests", "traceability", "revalidate"}:
            try:
                repo = D.connect_repo(body["repo"])
                ref = body["repo"].get("head") or body["repo"].get("ref") or await asyncio.wait_for(repo.default_branch(), 15)
                await asyncio.wait_for(repo.list_files(ref), 30)
            except Exception as e:  # noqa: BLE001
                raise HTTPException(422, f"Could not reach the repo {body['repo'].get('project')}: {str(e)[:160]}. Check the project name, the branch and the server's repo token.")
        if body.get("approvals") and not api_keys.can_approve(D.env, c):
            raise HTTPException(403, "This key may not approve gated steps. A person with an approving key sends the approval.")
        if not (body.get("requirement") or body.get("requirementUrl") or body.get("jiraKey") or body.get("scenarios") or body.get("cases") or body.get("repo")):
            raise HTTPException(400, "Give something to work from: requirement, requirementUrl, jiraKey, scenarios, cases or repo.")
        eid = f"evt-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(3)}"
        rec = {"id": eid, "release": release, "project": reg["project"]["id"], "jiraProject": reg["project"]["jiraProjectKey"], "agent": "custom" if "steps" in body else str(body["agent"]).lower(), "action": "steps" if "steps" in body else str(body["action"]).lower(), "caller": c, "warnings": warnings, "status": "queued", "createdAt": _now(),
               "callbackUrl": body.get("callbackUrl") or None, "steps": [{"agent": a, "stages": s, "status": "waiting"} for a, s in steps]}
        _save(rec, url)
        _spawn(_execute(rec, steps, _deps_for(D, rec["jiraProject"]), {k: body[k] for k in INPUT if k in body}))
        return {**_summary(rec), "statusUrl": f"/api/v1/events/{eid}", "artifactsUrl": f"/api/v1/events/{eid}/artifacts"}

    @app.get("/api/v1/events/{eid}")
    def status(eid: str, authorization: str = Header(default=""), x_api_key: str = Header(default="")):
        return _summary(mine(eid, who(authorization, x_api_key)))

    @app.get("/api/v1/events/{eid}/artifacts")
    def artifacts(eid: str, authorization: str = Header(default=""), x_api_key: str = Header(default="")):
        rec = mine(eid, who(authorization, x_api_key))
        return {"id": eid, "release": rec["release"], "status": rec["status"], "flags": rec.get("flags", []), "agents": {s["agent"]: s.get("artifacts", {}) for s in rec["steps"]}}

    @app.post("/api/v1/events/{eid}/approve", status_code=202)
    async def approve(eid: str, body: dict = Body(default={}), authorization: str = Header(default=""), x_api_key: str = Header(default="")):
        c = who(authorization, x_api_key)
        if not api_keys.can_approve(D.env, c):
            raise HTTPException(403, "This key may not approve gated steps.")
        rec = mine(eid, c)
        if rec["status"] != "needs-you":
            raise HTTPException(409, "This event is not waiting for approval.")
        rec["approvedBy"] = c
        ap = body.get("approvals")
        if not isinstance(ap, dict) or not ap:
            raise HTTPException(400, 'Send approvals like {"dast": true}.')
        steps = [(s["agent"], s.get("stages")) for s in rec["steps"]]
        rec.update(status="queued")
        _save(rec, url)
        _spawn(_execute(rec, steps, _deps_for(D, rec.get("jiraProject")), {"approvals": ap, **{k: v for k, v in (body.get("input") or {}).items() if k in INPUT}}, rec.get("resumeAt", 0)))
        return _summary(rec)
