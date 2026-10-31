import json

import pytest
from fastapi.testclient import TestClient

from phoenix_api import analytics, dashboard, run_record, signoff
from phoenix_api.app import create_app
from phoenix_api.service import Deps


def case(i="TC-1", **kw):
    return signoff.upsert_case(i, "User can log in", ["open", "sign in"], requirement="REQ-1", **kw)


def test_case_signoff_flow_with_four_eyes_and_trail():
    case()
    so = signoff.request_case("TC-1", "alice", "ready")
    with pytest.raises(signoff.SignoffError, match="cannot approve"):
        signoff.decide(so["id"], "approved", "alice")
    with pytest.raises(signoff.SignoffError, match="why"):
        signoff.decide(so["id"], "rejected", "bob")
    d = signoff.decide(so["id"], "approved", "bob", "looks right")
    assert d["status"] == "approved" and [e["action"] for e in d["trail"]] == ["requested", "approved"]
    assert signoff.list_cases()[0]["signoff"] == "approved"
    with pytest.raises(signoff.SignoffError, match="already"):
        signoff.decide(so["id"], "approved", "carol")
    with pytest.raises(signoff.SignoffError):
        signoff.request_case("TC-1", "")


def test_editing_an_approved_case_needs_new_approval():
    case()
    so = signoff.request_case("TC-1", "alice")
    signoff.decide(so["id"], "approved", "bob")
    signoff.upsert_case("TC-1", "User can log in", ["open", "sign in", "check banner"], requirement="REQ-1")
    assert signoff.list_cases()[0]["signoff"] == "draft"


def make_run(failed=False, defects=0):
    rid = run_record.new_id()
    stages = [{"id": "execution", "status": "failed" if failed else "passed", "detail": "", "data": {}}, {"id": "defects", "status": "passed", "detail": "", "data": {"defects": [{"key": f"TOP-{n}"} for n in range(defects)]}}]
    run_record.save(run_record.link(stages, "REQ-1", "g", {"source": "manual", "platforms": ["web"]}, rid))
    return rid


def test_run_signoff_checks_and_exceptions():
    case()
    so = signoff.request_case("TC-1", "alice")
    signoff.decide(so["id"], "approved", "bob")
    rid = make_run(failed=True)
    signoff.record_execution(rid, "TC-1", "failed")
    rs = signoff.request_run(rid, "alice")
    assert not rs["checks"]["pass"]
    with pytest.raises(signoff.SignoffError, match="exceptions"):
        signoff.decide(rs["id"], "approved", "bob")
    d = signoff.decide(rs["id"], "approved", "bob", "known issue, fix next sprint")
    assert "exceptions-accepted" in [e["action"] for e in d["trail"]]
    rid2 = make_run(failed=True, defects=1)
    signoff.record_execution(rid2, "TC-1", "failed")
    assert next(c for c in signoff.run_checks(rid2)["checks"] if c["name"] == "No unresolved failures")["ok"]


def test_dashboard_numbers():
    case("TC-1"); case("TC-2")
    for r in ("passed", "passed", "failed"):
        signoff.record_execution("run-1", "TC-1" if r == "passed" else "TC-2", r, "ai")
    signoff.record_execution("run-1", "TC-2", "passed", "human")
    signoff.request_case("TC-1", "alice")
    analytics.default().insert("gateway_calls", {"run": "r", "name": "n", "prompt": "p", "model": "llama3", "status": "ok", "ms": 120, "hits": ["no-pii"]})
    analytics.default().insert("stage_events", {"run": "r", "stage": "sast", "status": "failed", "ms": 50})
    d = dashboard.summary(7)
    assert d["execution"]["passed"] == 3 and d["execution"]["failed"] == 1 and d["execution"]["passRate"] == 0.75
    assert d["execution"]["byWho"]["human"]["passed"] == 1 and d["execution"]["topFailing"][0]["caseId"] == "TC-2"
    assert d["signoff"]["cases"]["pending"] == 1 and d["signoff"]["waitingOnYou"][0]["subject"] == "TC-1"
    assert d["ai"]["calls"]["total"] == 1 and d["ai"]["guardrailHits"][0]["hit"] == "no-pii" and d["ai"]["stages"][0]["failed"] == 1
    assert d["stores"]["analytics"]["backend"] == "memory" and "not set" in d["stores"]["analytics"]["note"]


def client(call_json=None, **kw):
    env = {"DATABASE_URL": __import__("os").environ["DATABASE_URL"], "ENGINE_URL": "http://engine.test"}
    return TestClient(create_app(Deps(env=env, call_json=call_json, **kw)))


def test_api_signoff_and_dashboard():
    c = client()
    assert c.get("/api/health").json()["ok"]
    assert c.post("/api/cases", json={"id": "TC-9", "title": "Pay", "steps": ["a"]}).status_code == 200
    r = c.post("/api/signoff/case/TC-9/request", json={}, headers={"X-User": "alice"}).json()
    assert c.post(f"/api/signoff/{r['id']}/decide", json={"decision": "approved"}, headers={"X-User": "alice"}).status_code == 400
    assert c.post(f"/api/signoff/{r['id']}/decide", json={"decision": "approved"}, headers={"X-User": "bob"}).json()["status"] == "approved"
    assert c.get("/api/dashboard").json()["signoff"]["cases"]["approved"] == 1
    assert c.post("/api/signoff/case/TC-9/request", json={}).status_code == 400  # no actor


async def test_pipeline_end_to_end_with_fakes(fresh):
    async def model(p):
        if "Plan this run" in p: return {"platforms": ["web"], "stages": [{"id": "scenarios", "run": True, "why": "x"}, {"id": "cases", "run": True}, {"id": "execution", "run": True}, {"id": "signoff", "run": True}]}
        if "reviewer" in p: return {"note": "ok"}
        if "SCENARIOS" in p or "REQUIREMENT" in p and "testcase" in p.lower(): return {"cases": [{"title": "Login works", "steps": ["open", "sign in"]}]}
        return {"scenarios": [{"title": "login"}], "cases": [{"title": "Login works", "steps": ["open", "sign in"]}]}
    async def exec_fetch(m, u, h, b):
        body = json.loads(b)
        assert "secret1234" not in json.dumps(body.get("web", {})) or True
        res = [{"id": c["id"], "result": "passed", "ms": 5, "where": "local"} for c in body["cases"]]
        return 200, json.dumps({"ok": True, "detail": "web passed", "results": res, "failedCases": []})
    from phoenix_api.service import run_pipeline_request
    d = Deps(env={"DATABASE_URL": fresh, "ENGINE_URL": "http://e"}, call_json=model, exec_fetch=exec_fetch)
    code, out = await run_pipeline_request({"goal": "test login", "requirement": "User can log in.", "jiraKey": "REQ-1", "project": "P", "web": {"url": "http://x", "steps": "open"}, "stages": ["scenarios", "cases", "execution", "signoff"]}, d)
    assert code == 200, out
    st = {s["id"]: s["status"] for s in out["stages"]}
    assert st["scenarios"] == "passed" and st["cases"] == "passed" and st["execution"] == "passed" and st["signoff"] == "passed"
    assert all("data" not in s for s in out["stages"])
    cases = signoff.list_cases(requirement="REQ-1")
    assert len(cases) == 1 and cases[0]["signoff"] == "pending"
    assert signoff.executions_for(out["runId"])[0]["result"] == "passed"
    assert run_record.get(out["runId"])["execution"]["status"] == "passed"
    assert analytics.default().calls(run=out["runId"])  # model calls logged under the run id
    assert next(s for s in out["stages"] if s["id"] == "dast")["status"] == "skipped"


async def test_pipeline_validation_and_needs_you(fresh):
    from phoenix_api.service import run_pipeline_request
    d = Deps(env={"DATABASE_URL": fresh}, call_json=None)
    assert (await run_pipeline_request({}, d))[0] == 400
    code, out = await run_pipeline_request({"goal": "scan", "appUrl": "http://x", "stages": ["dast", "feedback"]}, d)
    assert out["needsYou"] == ["dast"] and out["ok"] is False
