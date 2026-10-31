import json

import pytest

from phoenix_api import ai_pipeline, analytics, gateway, guardrails, jira as J, mcp_registry, pipeline, prompt_store, repo as R, traceability, unit_tests


def test_guardrails_redact_and_block():
    r = guardrails.run(guardrails.DEFAULT_RULES, "input", "key sk-abcdefghijklmnopqrstuvwx mail a.b@example.com card 4111 1111 1111 1111")
    assert "[SECRET]" in r["text"] and "[EMAIL]" in r["text"] and "[CARD]" in r["text"]
    assert guardrails.run(guardrails.DEFAULT_RULES, "input", "x" * 70000)["blocked"]
    with pytest.raises(ValueError):
        guardrails.check({"type": "nope"}, "x")


def test_prompt_versions_and_vars(fresh):
    prompt_store.save_version("hello", "Say {{x}}")
    prompt_store.save_version("hello", "Shout {{x}}", publish=False)
    assert prompt_store.get_prompt("hello", vars={"x": "hi"})["text"] == "Say hi"
    prompt_store.publish("hello", "shared", 2)
    p = prompt_store.get_prompt("hello", vars={"x": "hi"})
    assert p["text"] == "Shout hi" and p["version"] == 2
    with pytest.raises(ValueError):
        prompt_store.get_prompt("hello", vars={"y": 1})
    assert prompt_store.get_prompt("unit_test_gen")["id"].startswith("unit_test_gen:shared:v1:")
    assert len(prompt_store.import_registry()) >= 5


async def test_gateway_logs_without_text_and_falls_back():
    async def bad(p): raise RuntimeError("down")
    async def good(p): return {"echo": p}
    prompt_store.save_version("t", "Hello")
    r = await gateway.call_prompt("t", input="my password: hunter2hunter2", providers={"a": bad, "b": good}, default_models=["a", "b"], run="run-1")
    assert r["ok"] and r["model"] == "b" and "hunter2" not in json.dumps(r["value"])
    row = analytics.default().calls(run="run-1")[0]
    assert row["fell_back"] == 1 and "hunter2" not in json.dumps(row, default=str) and "echo" not in json.dumps(row, default=str)


async def test_mcp_allow_list():
    mcp_registry.add("docs", "http://mcp.test/rpc", {"Authorization": "Bearer s3cret"})
    assert mcp_registry.list_servers()[0]["headers"] == ["Authorization"]
    async def fetch(m, u, h, b):
        body = json.loads(b)
        res = {"tools": [{"name": "lookup", "description": "find docs"}]} if body["method"] == "tools/list" else {"content": "found"}
        return 200, json.dumps({"jsonrpc": "2.0", "id": 1, "result": res})
    await mcp_registry.refresh("docs", fetch=fetch)
    assert (await mcp_registry.call_tool("docs/lookup", {}, ["docs/lookup"], fetch=fetch)) == {"content": "found"}
    with pytest.raises(PermissionError):
        await mcp_registry.call_tool("docs/lookup", {}, [], fetch=fetch)


async def test_jira_dedupes_and_hides_token():
    calls = []
    async def fetch(m, u, h, b):
        calls.append((m, u, h))
        if "search/jql" in u:
            return 200, json.dumps({"issues": [{"key": "TOP-9"}]})
        if m == "POST" and u.endswith("/comment"):
            return 200, "{}"
        return 200, json.dumps({"key": "TOP-10"})
    j = J.Jira({"JIRA_BASE_URL": "https://x.atlassian.net", "JIRA_EMAIL": "a@b.c", "JIRA_API_TOKEN": "tok", "JIRA_PROJECT_KEY": "TOP"}, fetch)
    d = J.draft_defect({"id": "TC-1", "name": "Login fails", "error": "pw=hunter22"}, "REQ-1", ["hunter22"])
    assert "hunter22" not in d["description"]
    assert (await J.log_defect(j, d)) == {"commented": True, "key": "TOP-9"}
    async def err(m, u, h, b): return 500, "SECRET BODY"
    with pytest.raises(RuntimeError) as e:
        await J.Jira({"JIRA_BASE_URL": "https://x", "JIRA_EMAIL": "a", "JIRA_API_TOKEN": "tok"}, err).call("GET", "/x")
    assert "SECRET" not in str(e.value) and "tok" not in str(e.value)
    assert J.Jira({}).missing == ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"]


def fake_repo(files):
    class Fake:
        async def default_branch(self): return "main"
        async def list_files(self, ref): return list(files)
        async def read_file(self, p, ref): return files[p]
        opened = None
        async def open_pull_request(self, base, branch, title, f, body=""):
            Fake.opened = (base, branch, f)
            return {"url": "https://x/pr/1", "branch": branch}
    return Fake()


async def test_traceability_drops_invented_evidence():
    repo = fake_repo({"test-cases/login.json": json.dumps({"name": "User can log in with email", "steps": ["open", "sign in"]}), "generated/legacy.spec.ts": "test('old banner', () => {})", "src/app.js": "x"})
    req = "User can log in with email and password.\nUser can export an invoice as PDF."
    w = await traceability.check(req, repo)
    assert w["source"] == "words" and w["coverage"][1]["status"] == "missing" and w["coverage"][0]["status"] == "possible"
    async def model(p):
        if "separate thing" in p: return {"statements": ["log in", "export invoice"]}
        return {"coverage": [{"id": "R1", "status": "covered", "evidence": ["test-cases/login.json"]}, {"id": "R2", "status": "covered", "evidence": ["made/up.js"]}], "unrequired": [{"path": "generated/legacy.spec.ts"}, {"path": "ghost"}]}
    a = await traceability.check(req, repo, call_json=model)
    assert [c["status"] for c in a["coverage"]] == ["covered", "missing"] and len(a["unrequired"]) == 1


async def test_repo_never_writes_base_and_hides_errors():
    sent = []
    async def fetch(m, u, h, b):
        sent.append((m, u))
        if u.endswith("/git/ref/heads/main"): return 200, json.dumps({"object": {"sha": "abc"}})
        if u.endswith("/pulls"): return 200, json.dumps({"html_url": "https://gh/pr/2"})
        return 200, "{}"
    r = R.Repo("github", "o/r", "tok", fetch=fetch)
    out = await r.open_pull_request("main", "testops/x", "t", [{"path": "a.test.js", "content": "x"}])
    assert out["url"] == "https://gh/pr/2"
    assert not any(m == "PUT" and "branch" not in u and "contents" in u and "main" in u for m, u in sent)
    with pytest.raises(ValueError):
        R.Repo("github", "bad", "tok")


async def test_pipeline_gates_and_unavailable():
    async def ok(ctx): return {"ok": True, "detail": "fine", "data": {"secret": "v"}}
    hs = {s["id"]: ok for s in pipeline.STAGES}
    r = await pipeline.run_pipeline({}, hs, autonomy="run-everything")
    assert next(s for s in r["stages"] if s["id"] == "dast")["status"] == "needs-you"
    r2 = await pipeline.run_pipeline({}, hs, autonomy="run-everything", approvals={"dast": True})
    assert next(s for s in r2["stages"] if s["id"] == "dast")["status"] == "passed"
    r3 = await pipeline.run_pipeline({}, hs, autonomy="run-everything", approvals={"dast": True}, production=True)
    assert next(s for s in r3["stages"] if s["id"] == "execution")["status"] == "needs-you"
    r4 = await pipeline.run_pipeline({}, hs)  # default: defects asks
    assert next(s for s in r4["stages"] if s["id"] == "defects")["status"] == "needs-you"
    r5 = await pipeline.run_pipeline({}, {}, only=["scenarios"])
    assert next(s for s in r5["stages"] if s["id"] == "scenarios")["status"] == "not-built"


async def test_plan_drops_invented_stages_and_model_cannot_lower_gate():
    async def model(p): return {"platforms": ["web", "tv"], "stages": [{"id": "dast", "run": True}, {"id": "bogus", "run": True}, {"id": "scenarios", "run": False}]}
    plan = await ai_pipeline.plan_run("g", "r", model)
    assert plan["platforms"] == ["web"] and all(s["id"] != "bogus" for s in plan["stages"])
    assert not next(s for s in plan["stages"] if s["id"] == "scenarios")["run"]
    assert (await ai_pipeline.plan_run("g", "r", None))["source"] == "fallback"


def test_unit_tests_pick_and_semgrep():
    files = ["src/a.py", "src/test_a.py", "node_modules/x/y.js", "b.go", "c.rb", "src/Main.java"]
    assert unit_tests.pick_files(files, flagged=["b.go"], max=3) == ["b.go", "src/a.py", "src/Main.java"]
    assert unit_tests.LANGS["java"]["test"]("src/main/java/A.java") == "src/test/java/ATest.java"
    f = unit_tests.parse_semgrep(json.dumps({"results": [{"path": "./a.py", "check_id": "py.sqli", "extra": {"message": "bad"}, "start": {"line": 3}}]}))
    assert f == {"a.py": ["sqli: bad (line 3)"]}


async def test_generate_tests_checks_shape_and_syntax():
    async def read(f): return "def add(a,b): return a+b"
    gp = lambda n, p="shared": prompt_store.get_prompt(n, p)  # noqa: E731
    async def good(p): return {"code": "def test_add():\n    assert 1 == 1\n"}
    async def bad_syntax(p): return {"code": "def test_add(:\n"}
    async def no_test(p): return {"code": "x = 1"}
    assert len((await unit_tests.generate_tests(["a.py"], read, good, gp))["files"]) == 1
    assert "syntax" in (await unit_tests.generate_tests(["a.py"], read, bad_syntax, gp))["skipped"][0]["why"]
    assert (await unit_tests.generate_tests(["a.py"], read, no_test, gp))["files"] == []
