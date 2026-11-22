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


LEAD = "phx_lead-key"


def seed():
    db.doc_put("project", "shop", {"id": "shop", "name": "Shop", "jiraProjectKey": "SHP", "createdBy": "t", "createdAt": "x"})
    db.doc_put("project", "pay", {"id": "pay", "name": "Payments", "jiraProjectKey": "PAY", "createdBy": "t", "createdAt": "x"})
    for n, pr, jk, st in (("1", "shop", None, "open"), ("R2026.11.3", "shop", "SHP-12", "open"), ("OLD", "shop", None, "closed"), ("P1", "pay", None, "open")):
        db.doc_put("release-reg", n, {"number": n, "project": pr, "jiraKey": jk, "status": st, "createdBy": "t", "createdAt": "x"})


def app(keys=True, **kw):
    seed()
    env = {"PHOENIX_API_REQUIRE_JIRA": "false", "DATABASE_URL": db.engine_for().url.render_as_string(hide_password=False), **({"PHOENIX_API_KEYS": f"ilmu-code:{sha(KEY)},ci:{sha(KEY2)},lead:{sha(LEAD)}:approve"} if keys else {}), **kw.pop("env", {})}
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
                                      ({"agent": "scout", "action": "run"}, "registered release"), ({"agent": "scout", "action": "run", "release": "1"}, "something to work from"),
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


BASE = {"agent": "scout", "action": "run", "release": "1", "requirement": "Users can log in."}


@pytest.mark.parametrize("extra,msg", [
    ({"requirement": "x" * 60001}, "at most"), ({"requirement": "use password=hunter2hunter2 and AKIAABCDEFGHIJKLMNOP"}, "secret"), ({"production": True}, "production"),
    ({"appUrl": "https://app.example.com"}, "no allowed targets"), ({"appUrl": "https://u:p@app.example.com"}, "without a username"), ({"appUrl": "ftp://x"}, "http(s)"),
    ({"repo": {"provider": "svn", "project": "a/b"}}, "repo needs"), ({"repo": {"provider": "github", "project": "org/app", "head": "x; rm -rf /"}}, "not a valid"),
    ({"testData": {"bad name": "x"}}, "testData"), ({"testData": {"a": {"nested": 1}}}, "testData"), ({"cases": [{"name": "no id"}]}, "needs an id"), ({"scenarios": ["a"] * 201}, "200")])
def test_input_checks(extra, msg):
    with app() as c:
        r = c.post("/api/v1/events", json={**BASE, **extra}, headers=H())
        assert r.status_code == 400 and msg in r.json()["detail"], r.text


def test_targets_must_be_on_the_servers_allowlist():
    with app(env={"PHOENIX_API_TARGETS": "*.staging.example.com,10.1.0.0/16"}) as c:
        ok = c.post("/api/v1/events", json={**BASE, "appUrl": "https://shop.staging.example.com"}, headers=H())
        assert ok.status_code == 202
        for bad in ("https://example.com", "https://evil.com", "https://staging.example.com.evil.com", "http://10.2.0.1"):
            r = c.post("/api/v1/events", json={**BASE, "appUrl": bad}, headers=H())
            assert r.status_code == 400 and "not on the server's list" in r.json()["detail"], bad
        assert c.post("/api/v1/events", json={**BASE, "appUrl": "http://10.1.4.4"}, headers=H()).status_code == 202
        wait(c, ok.json()["id"])


def test_an_ai_caller_cannot_approve_its_own_gates():
    with app() as c:
        assert c.post("/api/v1/events", json={**BASE, "approvals": {"dast": True}}, headers=H()).status_code == 403
        assert c.post("/api/v1/events", json={**BASE, "approvals": {"dast": True}}, headers=H(LEAD)).status_code == 202
        eid = c.post("/api/v1/events", json=BASE, headers=H()).json()["id"]
        assert c.post(f"/api/v1/events/{eid}/approve", json={"approvals": {"dast": True}}, headers=H()).status_code == 403
        wait(c, eid)


def test_agents_can_be_called_together_in_the_callers_order():
    with app() as c:
        r = c.post("/api/v1/events", json={"release": "1", "requirement": "x", "steps": [{"agent": "scout", "action": "write-scenarios"}, {"agent": "scribe", "action": "write-cases"}]}, headers=H())
        assert r.status_code == 202 and [s["agent"] for s in r.json()["steps"]] == ["scout", "scribe"]
        done = wait(c, r.json()["id"])
        assert done["agent"] == "custom" and [s["agent"] for s in done["steps"]] == ["scout", "scribe"]
        for bad in ([], [{"agent": "scout"}] * 2, [{"agent": "nobody"}], ["scout"], [{"agent": "scout"}] * 14):
            assert c.post("/api/v1/events", json={"release": "1", "requirement": "x", "steps": bad}, headers=H()).status_code == 400


def test_generated_output_is_cleaned_before_it_leaves():
    env = {"PHOENIX_API_TARGETS": "*.staging.example.com"}
    art, flags = __import__("phoenix_api.release_checks", fromlist=["x"]).check_output(
        {"unitTests": [{"path": "t.py", "content": "key='AKIAABCDEFGHIJKLMNOP'\nrequests.get('https://evil.com/x')"}], "scenarios": ["not a dict"], "cases": [{"id": "c1", "steps": ["open https://a.staging.example.com"]}]}, env)
    assert "AKIA" not in str(art) and "scenarios" not in art and art["cases"][0]["id"] == "c1"
    assert any("secret redacted" in f for f in flags) and any("evil.com" in f for f in flags) and not any("a.staging" in f for f in flags) and any("scenarios" in f for f in flags)


def test_scans_without_a_linked_repo_say_so_and_never_scan_the_servers_own_folder():
    from phoenix_api.service import run_pipeline_request
    seen = []

    def fake_run(argv, *a, **k):
        seen.append(argv)
        import types
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")
    d = Deps(env={"DATABASE_URL": db.engine_for().url.render_as_string(hide_password=False)}, run=fake_run)
    code, out = asyncio.run(run_pipeline_request({"goal": "scan", "stages": ["secrets", "sast"], "autonomy": "run-everything"}, d))
    st = {s["id"]: s for s in out["stages"]}
    assert st["secrets"]["status"] == "unavailable" and "no code repo linked" in st["secrets"]["detail"] and st["sast"]["status"] == "unavailable"
    assert not [a for a in seen if a and a[0] in ("semgrep", "gitleaks")]


def test_scans_with_a_linked_repo_run_on_a_temporary_copy_that_is_deleted():
    import os
    from phoenix_api.service import run_pipeline_request
    seen = []

    class Repo:
        async def default_branch(self): return "main"
        async def list_files(self, ref): return ["app.py", "../evil", "/etc/passwd", "src/a.py"]
        async def read_file(self, f, ref): return "print(1)"

    def fake_run(argv, *a, **k):
        import types
        if argv and argv[0] in ("semgrep", "gitleaks"):
            seen.append((argv[0], [x for x in argv if os.path.isdir(str(x))][:1]))
            if seen[-1][1]:
                assert os.path.isfile(os.path.join(seen[-1][1][0], "src", "a.py")) and not os.path.exists(os.path.join(seen[-1][1][0], "..", "evil"))
        return types.SimpleNamespace(returncode=0, stdout="[]", stderr="")
    d = Deps(env={"DATABASE_URL": db.engine_for().url.render_as_string(hide_password=False)}, run=fake_run, connect_repo=lambda rq: Repo())
    code, out = asyncio.run(run_pipeline_request({"goal": "scan", "stages": ["sast"], "autonomy": "run-everything", "repo": {"provider": "github", "project": "org/app"}}, d))
    scans = [x for x in seen if x[1]]
    assert scans and scans[0][0] == "semgrep" and "phoenix-scan-" in scans[0][1][0] and not os.path.exists(scans[0][1][0])


def test_unit_tests_need_the_requirement_first():
    with app() as c:
        for act in ("write-unit-tests", "run-unit-tests", "open-tests-pr"):
            r = c.post("/api/v1/events", json={"agent": "forge", "action": act, "release": "1", "repo": {"provider": "github", "project": "org/app"}}, headers=H())
            assert r.status_code == 400 and "requirement" in r.json()["detail"], act


def test_the_repo_is_checked_for_connectivity_before_the_event_is_accepted():
    class Dead:
        async def default_branch(self): raise RuntimeError("404 Not Found")

    class Live:
        async def default_branch(self): return "main"
        async def list_files(self, ref): return ["a.py"]
    body = {"agent": "forge", "action": "write-unit-tests", "release": "1", "requirement": "x", "repo": {"provider": "github", "project": "org/app"}}
    with app(connect_repo=lambda rq: Dead()) as c:
        r = c.post("/api/v1/events", json=body, headers=H())
        assert r.status_code == 422 and "Could not reach the repo org/app" in r.json()["detail"]
    with app(connect_repo=lambda rq: Live()) as c:
        assert c.post("/api/v1/events", json=body, headers=H()).status_code == 202


def test_testops_names_are_the_action_names_and_scan_runs_both_checks():
    assert RE.plan("warden", "secrets") == [("warden", ["secrets"])] and RE.plan("warden", "sast") == [("warden", ["sast"])]
    assert RE.plan("warden", "scan") == [("warden", ["secrets", "sast"])]          # code quality / security (Semgrep) and leaks (Gitleaks) together
    assert RE.plan("prowler", "dast") == [("prowler", ["deployed", "dast"])]


QA = {"X-User": "head.qa@example.com"}


def reg_app(**kw):
    return app(env={"PHOENIX_QA_HEADS": "head.qa@example.com", "PHOENIX_ADMINS": "admin@example.com"}, **kw)


def test_only_the_head_of_qa_creates_releases_and_projects_need_a_jira_key():
    with reg_app() as c:
        mk = {"number": "R9.9", "project": "shop", "jiraKey": "SHP-99"}
        assert c.post("/api/registry/releases", json=mk, headers={"X-User": "dev@example.com"}).status_code == 403
        assert c.post("/api/registry/releases", json=mk, headers={"X-User": "admin@example.com"}).status_code == 403        # an administrator registers projects, not releases
        assert c.post("/api/registry/releases", json={**mk, "jiraKey": "PAY-1"}, headers=QA).status_code == 400            # the Jira issue must belong to the project's Jira project
        r = c.post("/api/registry/releases", json={**mk, "number": "R9." + str(int(time.time()))}, headers=QA)
        assert r.status_code == 200 and r.json()["status"] == "open" and r.json()["createdBy"] == "head.qa@example.com"
        assert c.post("/api/registry/projects", json={"id": "x1", "name": "X One", "jiraProjectKey": "bad key"}, headers=QA).status_code == 400
        assert c.post("/api/registry/projects", json={"id": "x1", "name": "X One", "jiraProjectKey": "XO"}, headers={"X-User": "dev@example.com"}).status_code == 403
    with app() as c:                                                            # nobody named: nobody can (fail-closed)
        assert c.post("/api/registry/releases", json={"number": "Z1", "project": "shop"}, headers=QA).status_code == 403


def test_events_must_name_a_registered_open_release_or_a_registered_project():
    with app() as c:
        ev = lambda **k: c.post("/api/v1/events", json={"agent": "scout", "action": "run", "requirement": "x", **k}, headers=H())  # noqa: E731
        assert ev(release="NOPE").status_code == 404 and ev(project="nope").status_code == 404 and ev().status_code == 400
        assert ev(release="OLD").status_code == 409 and "closed" in ev(release="OLD").json()["detail"]
        assert ev(release="P1", project="shop").status_code == 400                                                      # that release belongs to another project
        a = ev(release="1"); b = ev(project="Shop"); d = ev(project="pay")                                                # release alone, project by name, project by id
        assert (a.status_code, b.status_code, d.status_code) == (202, 202, 202)
        assert a.json()["project"] == "shop" and a.json()["jiraProject"] == "SHP" and b.json()["release"] == "" and d.json()["jiraProject"] == "PAY"
        for r in (a, b, d):
            wait(c, r.json()["id"])


def test_the_jira_key_must_belong_to_the_projects_jira_project_and_a_release_can_carry_one():
    with app() as c:
        base = {"agent": "scout", "action": "run", "release": "1"}
        assert c.post("/api/v1/events", json={**base, "jiraKey": "PAY-5"}, headers=H()).status_code == 400
        ok = c.post("/api/v1/events", json={**base, "jiraKey": "shp-5", "requirement": "x"}, headers=H())
        assert ok.status_code == 202
        wait(c, ok.json()["id"])
        # a release made by the Head of QA carries a Jira key, which then stands in for the requirement that unit tests need
        class Live:
            async def default_branch(self): return "main"
            async def list_files(self, ref): return []
        r = c.post("/api/v1/events", json={"agent": "forge", "action": "write-unit-tests", "release": "R2026.11.3", "repo": {"provider": "github", "project": "org/app"}}, headers=H())
        assert r.status_code in (202, 422), r.text            # not refused for a missing requirement: the release's Jira key supplies it
        assert "requirement" not in r.text if r.status_code == 422 else True


def test_without_a_release_or_project_the_api_says_what_to_do_and_lists_the_options():
    with app() as c:
        r = c.post("/api/v1/events", json={"agent": "scout", "action": "run", "requirement": "x"}, headers=H())
        j = r.json()
        assert r.status_code == 400 and "registered release" in j["detail"] and any("Head of QA" in n for n in j["next"])
        assert {"id": "shop", "name": "Shop", "jiraProjectKey": "SHP"} in j["projects"] and {"number": "1", "project": "shop"} in j["openReleases"]
        assert all(x["number"] != "OLD" for x in j["openReleases"])                   # closed releases are not offered
        u = c.post("/api/v1/events", json={"agent": "scout", "action": "run", "requirement": "x", "release": "MADE-UP"}, headers=H())
        assert u.status_code == 404 and u.json()["projects"]


def test_a_project_created_in_testops_is_picked_up_without_typing_it_again(monkeypatch):
    from phoenix_api import registry
    calls = []

    async def fake_get(url, headers):
        calls.append((url, headers["Authorization"]))
        return 200, {"projects": [{"id": 77, "name": "Loyalty App", "jira": {"projectKey": "LOY"}}, {"id": 78, "name": "No Jira", "jira": None}]}
    monkeypatch.setattr(registry, "_get", fake_get)
    env = {"TESTOPS_API_URL": "https://testops.example.com", "TESTOPS_API_TOKEN": "tok"}
    with app(env=env) as c:
        ev = lambda p: c.post("/api/v1/events", json={"agent": "scout", "action": "run", "requirement": "x", "project": p}, headers=H())  # noqa: E731
        r = ev("Loyalty App")
        assert r.status_code == 202 and r.json()["project"] == "loyalty-app" and r.json()["jiraProject"] == "LOY"
        assert calls[0][0].startswith("https://testops.example.com/api/projects") and calls[0][1] == "Bearer tok"
        wait(c, r.json()["id"])
        n = len(calls)
        assert ev("loyalty-app").status_code == 202 and len(calls) == n          # already known: TestOps is not asked again
        r = ev("78")
        assert r.status_code == 422 and "not linked to a Jira project" in r.json()["detail"]
        assert ev("ghost").status_code == 404
    with app() as c:                                                              # TestOps not configured: nothing is fetched
        assert c.post("/api/v1/events", json={"agent": "scout", "action": "run", "requirement": "x", "project": "Loyalty App2"}, headers=H()).status_code == 404


def test_the_jira_id_is_mandatory_for_a_project_linked_to_jira_and_must_exist_when_jira_is_connected():
    class FakeJira:
        missing = []
        project = ""

        async def call(self, method, path, body=None):
            if "SHP-404" in path:
                raise RuntimeError("404 Issue does not exist")
            return {"key": "SHP-1"}
    on = {"PHOENIX_API_REQUIRE_JIRA": "true"}
    base = {"agent": "scout", "action": "run", "release": "1", "requirement": "x"}
    with app(env=on) as c:
        r = c.post("/api/v1/events", json=base, headers=H())
        assert r.status_code == 400 and "jiraKey" in r.json()["detail"] and "SHP-123" in r.json()["detail"]
        ok = c.post("/api/v1/events", json={**base, "jiraKey": "SHP-1"}, headers=H())
        assert ok.status_code == 202
        wait(c, ok.json()["id"])
        # a release made by the Head of QA with a Jira issue supplies it
        rel = c.post("/api/v1/events", json={**base, "release": "R2026.11.3"}, headers=H())
        assert rel.status_code == 202
        wait(c, rel.json()["id"])
    with app(env=on, jira=FakeJira()) as c:
        assert c.post("/api/v1/events", json={**base, "jiraKey": "SHP-404"}, headers=H()).status_code == 422
        good = c.post("/api/v1/events", json={**base, "jiraKey": "SHP-1"}, headers=H())
        assert good.status_code == 202
        wait(c, good.json()["id"])


def test_failed_unit_tests_and_scan_findings_become_jira_defects_without_copying_secrets():
    from phoenix_api.service import findings_as_defects
    res = [{"id": "unitrun", "status": "failed", "data": {"failures": [{"language": "python", "kind": "unit", "name": "test_login", "requirement": "SHP-1"}]}},
           {"id": "sast", "status": "failed", "data": {"findings": {"app/db.py": ["sql-injection: string built from input (line 4)"]}}},
           {"id": "secrets", "status": "failed", "data": {"stdout": "Secret: AKIAABCDEFGHIJKLMNOP"}},
           {"id": "dast", "status": "failed", "detail": "ZAP alerts: 2 high", "data": {"alerts": {"high": 2}}}]
    d = findings_as_defects(res)
    assert [x["id"][:5] for x in d] == ["unit-", "sast-", "secre", "dast-"]
    assert "SHP-1" in str(d[0]) and "sql-injection" in d[1]["error"] and "AKIA" not in str(d)
    assert findings_as_defects(res) == d                                   # stable ids: the same finding is the same defect next run
    assert findings_as_defects([{"id": "sast", "status": "passed", "data": {"findings": {"a.py": ["x"]}}}, {"id": "secrets", "status": "unavailable"}]) == []


def test_a_run_through_the_api_raises_the_defects_in_the_projects_jira_project():
    import types
    from phoenix_api.service import run_pipeline_request
    made = []

    class FakeJira:
        missing, project, defect_type = [], "SHP", "Bug"

        async def call(self, method, path, body=None):
            if method == "GET" and "search" in path:
                return {"issues": []}
            made.append(body["fields"]["summary"])
            return {"key": f"SHP-{100 + len(made)}"}

    def fake_run(argv, *a, **k):
        out = '{"results":[{"path":"app/db.py","check_id":"x.sqli","extra":{"message":"bad query"},"start":{"line":4}}]}' if "--json" in argv else ""
        return types.SimpleNamespace(returncode=1 if "--json" in argv else 0, stdout=out, stderr="")

    class Repo:
        async def default_branch(self): return "main"
        async def list_files(self, ref): return ["app/db.py"]
        async def read_file(self, f, ref): return "q = 'select ' + x"
    d = Deps(env={"DATABASE_URL": db.engine_for().url.render_as_string(hide_password=False)}, run=fake_run, jira=FakeJira(), connect_repo=lambda rq: Repo())
    code, out = asyncio.run(run_pipeline_request({"goal": "g", "stages": ["sast", "defects"], "autonomy": "ask-when-matters", "repo": {"provider": "github", "project": "org/app"}, "approvals": {"defects": True}}, d))
    st = {s["id"]: s for s in out["stages"]}
    assert st["sast"]["status"] == "failed" and st["defects"]["status"] == "passed" and len(made) == 1 and "Semgrep finding in app/db.py" in made[0], (st["defects"], made)


def test_one_bug_for_everything_and_unit_tests_go_to_testops_first_then_jira():
    import types
    from phoenix_api import signoff
    from phoenix_api.service import consolidate, run_pipeline_request
    c1 = consolidate([{"id": "a", "name": "Login fails", "error": "500"}, {"id": "b", "name": "Semgrep finding in x.py", "error": "sqli"}], "R1", "run-20261119000000-abcdef")
    assert c1["name"] == "Phoenix found 2 problem(s) in R1" and len(c1["steps"]) == 2 and c1["id"] == consolidate([{"id": "z", "name": "n"}], "R1")["id"]   # same release, same bug
    made = []

    class FakeJira:
        missing, project = [], "SHP"
        async def call(self, method, path, body=None):
            if method == "GET":
                return {"issues": []}
            made.append((path, body))
            return {"key": f"SHP-{200 + len(made)}"}

    class Repo:
        async def default_branch(self): return "main"
        async def list_files(self, ref): return ["app.py"]
        async def read_file(self, f, ref): return "def add(a, b):\n    return a + b\n"

    async def model(p): return {"code": "def test_add():\n    assert 1 + 1 == 2\n"}
    for allowed, expect in ((False, 0), (True, 1)):
        made.clear()
        d = Deps(env={"DATABASE_URL": db.engine_for().url.render_as_string(hide_password=False)}, call_json=model, jira=FakeJira(), connect_repo=lambda rq: Repo())
        code, out = asyncio.run(run_pipeline_request({"goal": "g", "stages": ["unittests"], "requirement": "Add numbers", "jiraKey": "SHP-1", "project": "shop", "_artifacts": True,
                                                      "approvals": {"defects": allowed}, "repo": {"provider": "github", "project": "org/app"}}, d))
        u = next(s for s in out["stages"] if s["id"] == "unittests")
        reg = out["artifacts"].get("unitCases") if out.get("artifacts") else None
        cases = signoff.list_cases(project="shop")
        assert u["status"] == "passed", u
        assert any(x["title"].startswith("Unit tests: ") and x["requirement"] == "SHP-1" for x in cases)          # in TestOps either way
        assert len([m for m in made if m[0].endswith("/issue")]) == expect                                                # in Jira only with approval
        assert (reg or [{}])[0].get("jira", "") == ("SHP-201" if allowed else "")


def test_a_step_that_could_not_run_is_incomplete_not_passed(monkeypatch):
    async def fake(req, deps):
        return 200, {"ok": True, "needsYou": [], "summary": {"passed": 1, "unavailable": 1}, "stages": [{"id": "unittests", "status": "unavailable"}], "artifacts": {}}
    monkeypatch.setattr(RE, "run_pipeline_request", fake)
    class Live:
        async def default_branch(self): return "main"
        async def list_files(self, ref): return ["a.py"]
    with app(connect_repo=lambda rq: Live()) as c:
        r = c.post("/api/v1/events", json={"agent": "forge", "action": "write-unit-tests", "release": "R2026.11.3", "requirement": "Add numbers", "repo": {"provider": "github", "project": "org/app"}}, headers=H())
        out = wait(c, r.json()["id"], until=("passed", "failed", "incomplete", "needs-you"))
        assert out["status"] == "incomplete" and out["steps"][0]["status"] == "unavailable"


def test_github_can_be_read_without_a_token_but_not_changed():
    from phoenix_api import repo as R
    seen = []

    async def fetch(m, u, h, b=None):
        seen.append(h)
        return 200, '{"default_branch": "main"}'
    r = R.Repo("github", "o/a", None, fetch=fetch)
    assert asyncio.run(r.default_branch()) == "main" and "Authorization" not in seen[0]
    with pytest.raises(ValueError, match="GITHUB_TOKEN"):
        asyncio.run(r._call("POST", "/repos/o/a/pulls", {}))
    with pytest.raises(ValueError, match="GITLAB_TOKEN"):
        R.Repo("gitlab", "o/a", None)
