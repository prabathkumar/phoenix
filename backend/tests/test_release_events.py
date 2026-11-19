import asyncio
import hashlib
import time

import pytest
from fastapi.testclient import TestClient

from phoenix_api import agents, api_keys, db, release_events as RE, run_record
from phoenix_api.app import create_app
from phoenix_api.service import Deps

KEY, KEY2 = "phx_test-key-one", "phx_test-key-two"
H = lambda k=KEY: {"Authorization": f"Bearer {k}"}  # noqa: E731
sha = lambda k: hashlib.sha256(k.encode()).hexdigest()  # noqa: E731


async def model(p):
    return {"scenarios": [{"title": "Login works", "steps": ["open the page"]}]}


def app(keys=True, **kw):
    env = {"DATABASE_URL": db.engine_for().url.render_as_string(hide_password=False), **({"PHOENIX_API_KEYS": f"ilmu-code:{sha(KEY)},ci:{sha(KEY2)}"} if keys else {}), **kw.pop("env", {})}
    return TestClient(create_app(Deps(env=env, call_json=model, **kw)))


def wait(c, eid, key=KEY, until=("passed", "failed", "needs-you", "interrupted")):
    for _ in range(100):
        r = c.get(f"/api/v1/events/{eid}", headers=H(key)).json()
        if r["status"] in until:
            return r
        time.sleep(0.1)
    raise AssertionError(r)


def test_closed_without_keys_and_with_a_wrong_key():
    with app(keys=False) as c:
        assert c.post("/api/v1/events", json={}, headers=H()).status_code == 503
    with app() as c:
        assert c.post("/api/v1/events", json={"agent": "scout", "action": "run", "release": "1"}).status_code == 401
        assert c.post("/api/v1/events", json={"agent": "scout", "action": "run", "release": "1"}, headers=H("nope")).status_code == 401
        assert c.get("/api/v1/actions", headers=H()).json()["agents"]["forge"][0] == "run"


def test_keys_are_hashes_and_matched_by_name():
    env = {"PHOENIX_API_KEYS": f"a:{sha('k1')},b:{sha('k2')},bad:short"}
    assert api_keys.caller(env, "Bearer k2") == "b" and api_keys.caller(env, "", "k1") == "a" and api_keys.caller(env, "Bearer k3") is None and "bad" not in api_keys.parse(env)


def test_every_action_stage_belongs_to_that_agent_in_the_roster():
    ro = {a["name"]: set(a["stages"]) for a in agents.roster()}
    for name, acts in RE.ACTIONS.items():
        for act, stages in acts.items():
            assert set(stages) <= ro[name], (name, act)
    assert set(RE.TEAM) == set(ro)


@pytest.mark.parametrize("body,msg", [({"agent": "nobody", "action": "run", "release": "1"}, "Unknown agent"), ({"agent": "forge", "action": "execute", "release": "1"}, "does not do"), ({"agent": "team", "action": "run", "release": "1"}, "only does"),
                                      ({"agent": "scout", "action": "run"}, "release number"), ({"agent": "scout", "action": "run", "release": "1"}, "something to work from"),
                                      ({"agent": "scout", "action": "run", "release": "1", "requirement": "x", "callbackUrl": "http://x.example.com"}, "https")])
def test_bad_events_are_refused_in_plain_words(body, msg):
    with app() as c:
        r = c.post("/api/v1/events", json=body, headers=H())
        assert r.status_code == 400 and msg in r.json()["detail"]


def test_an_event_runs_the_agent_and_returns_what_it_created():
    with app() as c:
        r = c.post("/api/v1/events", json={"agent": "scout", "action": "write-scenarios", "release": "R2026.11.3", "requirement": "Users can log in with a password."}, headers=H())
        assert r.status_code == 202 and r.json()["status"] == "queued"
        eid = r.json()["id"]
        done = wait(c, eid)
        assert done["status"] == "passed", done
        assert done["caller"] == "ilmu-code" and done["steps"][0]["agent"] == "scout" and done["steps"][0]["stages"] == ["scenarios"]
        art = c.get(f"/api/v1/events/{eid}/artifacts", headers=H()).json()
        assert art["agents"]["scout"]["scenarios"][0]["title"] == "Login works"
        run = run_record.get(done["steps"][0]["runId"])
        assert run["release"] == "R2026.11.3"
        assert next(s for s in run["stages"] if s["id"] == "scenarios")["status"] == "passed"
        assert next(s for s in run["stages"] if s["id"] == "execution")["status"] == "skipped"       # the action narrowed the agent to one stage


def test_a_switched_off_agent_is_skipped_and_never_switched_on():
    with app() as c:
        cur = agents.get("scribe")
        agents.set_enabled("scribe", False, "bob")
        try:
            eid = c.post("/api/v1/events", json={"agent": "scribe", "action": "run", "release": "1", "requirement": "x"}, headers=H()).json()["id"]
            done = wait(c, eid)
            assert done["steps"][0]["status"] == "skipped" and "switched off" in done["steps"][0]["detail"] and agents.get("scribe")["enabled"] is False
        finally:
            agents.set_enabled("scribe", cur["enabled"], "bob")


def test_a_caller_cannot_read_another_callers_event():
    with app() as c:
        eid = c.post("/api/v1/events", json={"agent": "scout", "action": "run", "release": "1", "requirement": "x"}, headers=H()).json()["id"]
        assert c.get(f"/api/v1/events/{eid}", headers=H(KEY2)).status_code == 404
        assert c.get("/api/v1/events/evt-bad", headers=H()).status_code == 404
        wait(c, eid)


def test_callback_needs_a_secret_and_never_goes_to_a_private_address():
    assert "not set" in asyncio.run(RE._deliver("https://hooks.example.com/x", {"status": "passed"}, {}, False))
    assert "private" in asyncio.run(RE._deliver("https://127.0.0.1/x", {"status": "passed"}, {"PHOENIX_WEBHOOK_SECRET": "s"}, False))
