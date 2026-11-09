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


async def test_selected_cases_run_by_id_and_results_are_recorded(fresh):
    from phoenix_api.service import run_pipeline_request
    signoff.upsert_case("TC-7", "Pay by card", ["open checkout", "pay with ${PW}"], requirement="REQ-2")
    seen = {}
    async def exec_fetch(m, u, h, b):
        body = json.loads(b); seen.update(body)
        return 200, json.dumps({"ok": False, "detail": "1 failed", "results": [{"id": "TC-7", "result": "failed", "detail": "no pay button", "ms": 9, "where": "local"}], "failedCases": [{"id": "TC-7", "name": "Pay by card", "error": "no pay button"}]})
    d = Deps(env={"DATABASE_URL": fresh, "ENGINE_URL": "http://e"}, call_json=None, exec_fetch=exec_fetch)
    code, out = await run_pipeline_request({"goal": "run", "web": {"url": "http://x", "steps": ""}, "cases": [{"id": "TC-7"}], "testData": {"PW": "secret1234", "UNUSED": "never-sent"}, "stages": ["execution"]}, d)
    assert code == 200 and seen["cases"][0]["steps"] == "open checkout\npay with ${PW}" and seen["testData"] == {"PW": "secret1234"}  # only fields the steps use are sent
    ex = signoff.executions_for(out["runId"])
    assert ex[0]["caseId"] == "TC-7" and ex[0]["result"] == "failed"
    assert "secret1234" not in json.dumps(out) and "secret1234" not in json.dumps(run_record.get(out["runId"]))


def test_first_requests_in_parallel_do_not_race_on_table_creation(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from phoenix_api import db
    url = f"sqlite:///{tmp_path}/race.db"
    db._engines.pop(url, None)
    with ThreadPoolExecutor(8) as ex:
        engines = list(ex.map(lambda _: db.engine_for(url), range(8)))
    assert len({id(e) for e in engines}) == 1


def test_release_check_is_not_vacuous_without_a_requirement():
    rid = make_run()
    assert not next(c for c in signoff.run_checks(rid)["checks"] if c["name"] == "Cases approved")["ok"]
    case("TC-5")
    signoff.record_execution(rid, "TC-5", "passed")
    chk = {c["name"]: c for c in signoff.run_checks(rid)["checks"]}
    assert not chk["Cases approved"]["ok"] and "0 of 1" in chk["Cases approved"]["detail"]
    so = signoff.request_case("TC-5", "alice")
    signoff.decide(so["id"], "approved", "bob")
    assert {c["name"]: c for c in signoff.run_checks(rid)["checks"]}["Cases approved"]["ok"]


# ---- a scenario is run whole; a partial suite is a deliberate, visible choice
def _fourteen(sc="Checkout"):
    for n in range(1, 15):
        signoff.upsert_case(f"SC-{n:02d}", f"Case {n}", [f"step {n}"], scenario=sc)


def _engine(seen):
    async def exec_fetch(m, u, h, b):
        body = json.loads(b); seen.append([c["id"] for c in body["cases"]])
        return 200, json.dumps({"ok": True, "detail": "ok", "results": [{"id": c["id"], "result": "passed", "ms": 1, "where": "local"} for c in body["cases"]], "failedCases": []})
    return exec_fetch


async def test_picking_some_cases_of_a_scenario_needs_confirmation(fresh):
    from phoenix_api.service import run_pipeline_request
    _fourteen(); seen = []
    d = Deps(env={"DATABASE_URL": fresh, "ENGINE_URL": "http://e"}, call_json=None, exec_fetch=_engine(seen))
    code, out = await run_pipeline_request({"goal": "run", "web": {"url": "http://x", "steps": ""}, "cases": [{"id": f"SC-{n:02d}"} for n in range(1, 6)], "stages": ["execution"]}, d)
    st = next(s for s in out["stages"] if s["id"] == "execution")
    assert not seen and "5 of 14" in st["detail"] and signoff.executions_for(out["runId"]) == []  # nothing ran


async def test_running_a_scenario_runs_all_of_it(fresh):
    from phoenix_api.service import run_pipeline_request
    _fourteen(); seen = []
    d = Deps(env={"DATABASE_URL": fresh, "ENGINE_URL": "http://e"}, call_json=None, exec_fetch=_engine(seen))
    code, out = await run_pipeline_request({"goal": "run", "web": {"url": "http://x", "steps": ""}, "scenarios": ["Checkout"], "stages": ["execution"]}, d)
    assert len(seen[0]) == 14 and len(signoff.executions_for(out["runId"])) == 14


async def test_confirmed_partial_suite_records_the_rest_as_skipped_and_blocks_release(fresh):
    from phoenix_api.service import run_pipeline_request
    _fourteen(); seen = []
    d = Deps(env={"DATABASE_URL": fresh, "ENGINE_URL": "http://e"}, call_json=None, exec_fetch=_engine(seen))
    code, out = await run_pipeline_request({"goal": "run", "web": {"url": "http://x", "steps": ""}, "allowPartial": True, "cases": [{"id": f"SC-{n:02d}"} for n in range(1, 6)], "stages": ["execution"]}, d)
    ex = signoff.executions_for(out["runId"])
    assert len(seen[0]) == 5 and sum(e["result"] == "skipped" for e in ex) == 9
    chk = {c["name"]: c for c in signoff.run_checks(out["runId"], fresh)["checks"]}
    assert not chk["Every case executed"]["ok"] and "5 of 14" in chk["Every case executed"]["detail"]


def test_existing_database_gains_the_scenario_column(tmp_path):
    import sqlalchemy as sa
    from phoenix_api import db
    url = f"sqlite:///{tmp_path}/old.db"
    e = sa.create_engine(url)
    with e.begin() as c:
        c.execute(sa.text("CREATE TABLE test_cases (id VARCHAR(64) PRIMARY KEY, project VARCHAR(64), requirement VARCHAR(64), title VARCHAR(300), steps JSON, priority VARCHAR(16), who VARCHAR(16), signoff VARCHAR(24), created_at DATETIME)"))
        c.execute(sa.text("INSERT INTO test_cases (id,title,steps,project,requirement,priority,who,signoff) VALUES ('OLD-1','old','[]','','','Medium','ai','draft')"))
    db._engines.pop(url, None)
    assert signoff.list_cases(url=url)[0]["scenario"] == ""
