import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from phoenix_api import api_layer as A, api_functional as F, handlers as H, unit_tests as U  # noqa: E402

SPEC = json.dumps({"openapi": "3.0.0", "paths": {
    "/users": {"post": {"summary": "create", "requestBody": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/New"}}}},
                        "responses": {"201": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/User"}}}}}}},
    "/users/{id}": {"get": {"parameters": [{"name": "id", "in": "path", "required": True, "schema": {"type": "integer"}}],
                            "responses": {"200": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/User"}}}}}}}},
    "components": {"schemas": {"New": {"type": "object", "required": ["name", "age"], "properties": {"name": {"type": "string", "maxLength": 5}, "age": {"type": "integer", "minimum": 18, "maximum": 99}}},
                               "User": {"type": "object", "required": ["id", "name"], "properties": {"id": {"type": "integer"}, "name": {"type": "string"}}}}}})


def test_endpoints_in_each_language():
    assert [(e["method"], e["path"]) for e in A.detect_endpoints("a.js", "app.get('/u/:id', h)\nrouter.post(\"/u\", h)", "javascript")] == [("GET", "/u/{id}"), ("POST", "/u")]
    assert A.detect_endpoints("a.py", "@app.get('/x/{i}')\n@bp.route('/y', methods=['POST','GET'])", "python")[0]["path"] == "/x/{i}"
    assert len(A.detect_endpoints("a.py", "@bp.route('/y', methods=['POST','GET'])", "python")) == 2
    j = A.detect_endpoints("C.java", '@RequestMapping("/api")\n@GetMapping("/a")\n@PostMapping', "java")
    assert [e["path"] for e in j] == ["/api/a", "/api"]
    assert A.detect_endpoints("r.php", "Route::put('/p/{id}', x);", "php")[0]["method"] == "PUT"
    assert A.detect_endpoints("m.go", 'r.GET("/g", h)\nhttp.HandleFunc("POST /h", f)', "go")[1]["method"] == "POST"
    assert A.detect_endpoints("UserController.cs", '[Route("api/[controller]")]\n[HttpGet("{id}")]', "csharp")[0]["path"] == "/api/user/{id}"
    assert A.detect_endpoints("x.js", "no routes", "javascript") == [] and A.detect_endpoints("x.js", None, "javascript") == []


def test_openapi_and_data_from_schema():
    eps = A.from_openapi(SPEC)
    post = next(e for e in A.analyse(["openapi.json"], {"openapi.json": SPEC}, U.language_of)["endpoints"] if e["method"] == "POST")
    assert len(eps) == 2
    td = post["testData"]["request"]
    assert td["valid"] == {"name": "test-", "age": 18} or td["valid"]["age"] == 18
    names = [i["name"] for i in td["invalid"]]
    assert "age below minimum" in names and "name is missing" in names and "age has the wrong type" in names and "name over max length" in names
    assert any(b["value"]["age"] == 99 for b in td["boundary"])
    assert A.sample_data(None)["valid"] is None
    assert A.from_openapi("not a spec") == []


def test_cases_and_shape():
    eps = A.analyse(["openapi.json"], {"openapi.json": SPEC}, U.language_of)["endpoints"]
    cases = F.build_cases(eps, "PROJ-1")
    assert all(c["name"].startswith("PROJ-1 ") for c in cases)
    assert any(c["path"] == "/users/999999999" and c["expect"]["status"] == 404 for c in cases)
    assert F.check_shape({"type": "object", "required": ["id"], "properties": {"id": {"type": "integer"}}}, {"id": "x"}) == ["$.id should be integer"]
    assert F.check_shape({"type": "object", "required": ["id"]}, {}) == ["$.id is missing"]


def test_run_cases_rules():
    eps = A.analyse(["openapi.json"], {"openapi.json": SPEC}, U.language_of)["endpoints"]
    cases = F.build_cases(eps)
    seen = []

    async def fetch(m, url, h, body):
        seen.append((m, url))
        if m == "POST" and body and '"age": 17' in body:
            return 400, "{}"
        if m == "POST":
            return 500, "boom" if body in ("{}", "[]") else "{}"
        return (404, "{}") if url.endswith("999999999") else (200, '{"id": 1, "name": "a"}')
    res = asyncio.run(F.run_cases("http://x", cases, fetch, allow_writes=False))
    assert any(r["result"] == "skipped" for r in res)                       # valid writes are not sent
    bad = [r for r in res if r["result"] == "failed"]
    assert any("server error 500" in r["detail"] for r in bad)              # invalid data that crashes the server is a failure
    assert any(r["result"] == "passed" and "valid data" in r["name"] for r in res)
    assert F.summary(res)["failed"] == len(bad)
    boom = asyncio.run(F.run_cases("http://x", [c for c in cases if c["method"] == "GET"][:1], lambda *a: (_ for _ in ()).throw(OSError("down"))))
    assert boom[0]["result"] == "failed"


class FakeRepo:
    def __init__(self, files):
        self.files = files

    async def default_branch(self):
        return "main"

    async def list_files(self, ref):
        return list(self.files)

    async def read_file(self, p, ref):
        return self.files[p]

    async def changed_files(self, b, h):
        return []


def test_link_and_functional_handler_and_ssrf():
    files = {"src/app.js": "app.get('/items/:id', h)\napp.post('/items', h)", "src/app.test.js": "test('x',()=>{})", "pom.xml": "<x/>"}
    r = asyncio.run(H.repolink_handler(lambda rq: FakeRepo(files))({"repoRequest": {"project": "o/n"}}))
    assert r["ok"] and r["data"]["main"] == "javascript" and r["data"]["apiCalls"] == 2 and r["data"]["languages"][0]["testFiles"] == 1 and r["data"]["next"] == "unit-tests"
    assert asyncio.run(H.repolink_handler(lambda rq: FakeRepo({}))({"repoRequest": {"project": "o/n"}}))["ok"] is False
    plan = asyncio.run(H.apifunc_handler(lambda rq: FakeRepo(files))({"repoRequest": {"project": "o/n"}}))
    assert plan["ok"] and plan["data"]["results"] == [] and plan["data"]["cases"]
    blocked = asyncio.run(H.apifunc_handler(lambda rq: FakeRepo(files))({"repoRequest": {"project": "o/n", "apiBaseUrl": "http://169.254.169.254"}}))
    assert blocked["unavailable"]
    none = asyncio.run(H.apifunc_handler(lambda rq: FakeRepo({"a.js": "x"}))({"repoRequest": {"project": "o/n"}}))
    assert none["ok"] is False
    ran = asyncio.run(H.apifunc_handler(lambda rq: FakeRepo(files), fetch=lambda m, u, h, b: asyncio.sleep(0, (200, "{}")), env={})({"repoRequest": {"project": "o/n", "apiBaseUrl": "http://localhost:3000"}}))
    assert ran["data"]["summary"]["passed"] > 0


def test_api_tests_written_with_markers():
    eps = A.analyse(["s/app.py"], {"s/app.py": "@app.get('/items/{id}')\ndef f(): pass"}, U.language_of)["endpoints"]
    gotp = []

    async def call(prompt):
        gotp.append(prompt)
        return {"code": "def test_get_item():\n    assert True\n"}
    r = asyncio.run(U.generate_api_tests(eps, None, call, lambda n, p: {"text": "T"}, requirement={"key": "PROJ-9", "text": "items"}))
    t = r["files"][0]
    assert t["kind"] == "integration" and "pytest.mark.integration" in t["content"] and t["path"] == "tests/test_app_api_integration.py"
    assert "API_BASE_URL" in gotp[0] and "PROJ-9" in gotp[0] and "999999999" in gotp[0]
    assert U.mark_integration("go", "package x")[0].startswith("//go:build integration")
    assert 'Trait("Category", "Integration")' in U.mark_integration("csharp", "\npublic class A {}")[0]
    assert "@group integration" in U.mark_integration("php", "<?php\nfinal class A {}")[0]
    empty = asyncio.run(U.generate_api_tests(eps, None, lambda p: asyncio.sleep(0, {"code": ""}), lambda n, p: {"text": "T"}))
    assert empty["skipped"] and not empty["files"]


def test_hostile_data_and_flaky_detection():
    eps = A.analyse(["openapi.json"], {"openapi.json": SPEC}, U.language_of)["endpoints"]
    hc = F.hostile_cases(eps)
    assert any("hostile name (empty)" in c["name"] for c in hc) and any("DROP TABLE" in json.dumps(c["body"]) for c in hc) and all(c["expect"]["status"] == "not5xx" for c in hc)
    assert not any("age" in c["name"] for c in hc), "only text fields get hostile text"
    n = {"calls": 0}

    async def fetch(m, url, h, body):
        if body and "DROP TABLE" in body:
            return 500, "boom"                          # hostile input crashes the server
        if m == "GET" and url.endswith("/users/1"):
            n["calls"] += 1
            return (200, '{"id": 1, "name": "a"}') if n["calls"] % 2 else (503, "")   # every other answer fails: flaky
        return (404, "{}") if url.endswith("999999999") else (400, "{}")
    rows, flaky = asyncio.run(F.run_repeated("http://x", F.build_cases(eps), fetch, times=4))
    assert any("users/{id} with valid data" in f for f in flaky)
    hrows, _ = asyncio.run(F.run_repeated("http://x", hc, fetch, times=2, allow_writes=True))
    assert any(r["result"] == "failed" and "server error 500" in r["detail"] for r in hrows)
    assert any(r["result"] == "passed" for r in hrows)


def test_revalidate_handler_reports_failing_flaky_and_says_when_nothing_ran():
    files = {"openapi.json": SPEC}
    state = {"n": 0}

    async def fetch(m, url, h, body):
        if body and "DROP TABLE" in body:
            return 500, ""
        if m == "GET" and url.endswith("/users/1"):
            state["n"] += 1
            return (200, '{"id": 1, "name": "a"}') if state["n"] % 2 else (500, "")
        return (404, "{}") if url.endswith("999999999") else (400, "{}")
    r = asyncio.run(H.revalidate_handler(lambda rq: FakeRepo(files), fetch=fetch, env={})({"repoRequest": {"project": "o/n", "apiBaseUrl": "http://localhost:3000", "allowWrites": True, "repeat": 2}}))
    assert r["ok"] is False and r["data"]["parts"]["functional"]["ran"] > 0 and r["data"]["parts"]["negative"]["failed"] > 0 and "failing" in r["detail"]
    none = asyncio.run(H.revalidate_handler(lambda rq: FakeRepo(files), fetch=fetch)({"repoRequest": {"project": "o/n"}}))
    assert none["unavailable"] and "nothing to re-check" in none["detail"]
    assert asyncio.run(H.revalidate_handler(lambda rq: FakeRepo(files), fetch=fetch)({"repoRequest": {"project": "o/n", "apiBaseUrl": "http://169.254.169.254"}}))["unavailable"]
