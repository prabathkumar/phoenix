"""Developers: unit tests from a requirement and the changed code; runs repeat; a requirement is followed end to end."""
import asyncio
import os

import pytest
from fastapi.testclient import TestClient

from phoenix_api import handlers as H, lifecycle, logstore, signoff
from phoenix_api.app import create_app
from phoenix_api.service import Deps


class FakeRepo:
    def __init__(self):
        self.files = {"src/a.py": "def add(a,b): return a+b\n", "src/b.py": "def sub(a,b): return a-b\n", "README.md": "x", "src/c.php": "<?php function m(){}"}
        self.read = []

    async def default_branch(self): return "main"
    async def list_files(self, ref): return list(self.files)
    async def read_file(self, p, ref): self.read.append(p); return self.files[p]
    async def changed_files(self, base, head): return [{"path": "src/b.py", "status": "modified", "patch": "@@ -1 +1 @@\n-return a+b\n+return a-b"}, {"path": "src/a.py", "status": "removed", "patch": ""}]


def prompt(n, p="shared"): return {"text": "WRITE TESTS"}


def run(coro): return asyncio.run(coro)


def test_changed_code_and_requirement_reach_the_model_and_the_key_names_the_tests():
    seen = []

    async def model(p):
        seen.append(p)
        return "def test_PROJ_5_sub():\n    assert 1 == 1\n"
    repo = FakeRepo()
    h = H.unittests_handler(model, prompt, lambda rq: repo)
    r = run(h({"repoRequest": {"provider": "github", "project": "o/r", "base": "main", "head": "feat", "requirement": {"key": "PROJ-5", "text": "Subtract two numbers"}}, "results": []}))
    assert r["ok"] and r["data"]["changedFiles"] == 1 and r["data"]["requirement"] == "PROJ-5"
    assert len(seen) == 1 and "CHANGED LINES" in seen[0] and "return a-b" in seen[0] and "REQUIREMENT PROJ-5" in seen[0] and "PROJ_5" in seen[0]
    assert repo.read == ["src/b.py"], "only the changed (not removed) source file is tested"
    assert r["data"]["tests"][0]["path"] == "src/test_b.py" and r["data"]["tests"][0]["requirement"] == "PROJ-5"


def test_nothing_changed_is_said_plainly():
    repo = FakeRepo()

    async def none(*a): return []
    repo.changed_files = none
    r = run(H.unittests_handler(lambda p: "x", prompt, lambda rq: repo)({"repoRequest": {"project": "o/r", "base": "a", "head": "b"}, "results": []}))
    assert r["ok"] and "nothing changed" in r["detail"]


def test_a_php_file_gets_a_phpunit_test_path():
    async def model(p): return "<?php\nclass FooTest { public function testIt() { $this->assertSame(1, 1); } }\n"
    repo = FakeRepo()
    r = run(H.unittests_handler(model, prompt, lambda rq: repo)({"repoRequest": {"project": "o/r", "files": ["src/c.php"]}, "results": []}))
    assert r["data"]["tests"][0]["language"] == "php" and r["data"]["tests"][0]["path"] == "tests/cTest.php"


def _py_project(tmp_path, failing=False):
    (tmp_path / "pytest.ini").write_text("[pytest]\nmarkers = integration: x\n")
    (tmp_path / "requirements.txt").write_text("")
    (tmp_path / "test_a.py").write_text(f"import pytest\ndef test_PROJ_7_unit(): assert {not failing}\n@pytest.mark.integration\ndef test_PROJ_7_flow(): pass\ndef test_orphan(): pass\n")


def test_repeated_runs_link_to_the_requirement_and_the_latest_run_decides(tmp_path):
    _py_project(tmp_path, failing=True)
    h = lambda rid: H.unitrun_handler("p", rid, {"PHOENIX_UNIT_ROOT": str(tmp_path)})  # noqa: E731
    first = run(h("run-1")({"repoRequest": {"dir": str(tmp_path)}}))
    assert not first["ok"] and "1 failed" in first["detail"]
    _py_project(tmp_path, failing=False)
    second = run(h("run-2")({"repoRequest": {"dir": str(tmp_path)}}))
    assert second["ok"]
    lc = lifecycle.build("p")
    r = next(x for x in lc["requirements"] if x["requirement"] == "PROJ-7")
    assert r["unit"]["runs"] == 2 and r["reached"]["unitTests"] and r["reached"]["unitPassing"] and r["reached"]["integrationPassing"]
    assert any("flaky" in x or True for x in [r["unit"]]) and r["unit"]["flaky"], "the same test failed in run 1 and passed in run 2"
    assert lc["unlinkedTests"] == 1 and "test_orphan" in lc["unlinkedSample"][0]
    assert not r["done"] and "Test cases" in r["missing"]


def test_requirement_reaches_done_only_when_every_stage_is_reached(tmp_path):
    _py_project(tmp_path)
    run(H.unitrun_handler("p", "r1", {"PHOENIX_UNIT_ROOT": str(tmp_path)})({"repoRequest": {"dir": str(tmp_path)}}))
    signoff.upsert_case("C1", "Subtract", ["a"], project="p", requirement="PROJ-7", scenario="S1")
    signoff.request_case("C1", "ann")
    s = next(x for x in signoff.list_signoffs(kind="case") if x["subject"] == "C1")
    signoff.decide(s["id"], "approved", "bob", "ok")
    signoff.record_execution("run-x", "C1", "passed", "ai")
    r = next(x for x in lifecycle.build("p")["requirements"] if x["requirement"] == "PROJ-7")
    assert r["done"], r["missing"]
    logstore.record("defect", {"project": "p", "dkey": "D1", "case_id": "C1", "found_in": "system", "status": "open"})
    r = next(x for x in lifecycle.build("p")["requirements"] if x["requirement"] == "PROJ-7")
    assert not r["done"] and r["missing"] == ["No open defects"]


def test_unit_run_without_a_checkout_says_what_is_needed():
    r = run(H.unitrun_handler("p", "r", {})({"repoRequest": {}}))
    assert r.get("unavailable") and "checkout" in r["detail"]


def test_api_lifecycle_connectors_generate_and_run(tmp_path):
    _py_project(tmp_path)
    repo = FakeRepo()

    async def model(p): return "def test_PROJ_5_sub():\n    assert True\n"
    c = TestClient(create_app(Deps(env={"PHOENIX_UNIT_ROOT": str(tmp_path)}, call_json=model, connect_repo=lambda rq: repo)))
    assert c.get("/api/unit-tests/connectors").json()["languages"]["php"]["convention"]
    g = c.post("/api/unit-tests/generate", json={"requirementKey": "PROJ-5", "requirement": "Subtract", "repo": {"provider": "github", "project": "o/r", "base": "a", "head": "b"}}, headers={"X-User": "dev1"}).json()
    assert g["ok"] and g["data"]["tests"][0]["requirement"] == "PROJ-5"
    r = c.post("/api/unit-tests/run", json={"project": "p", "repo": {"dir": str(tmp_path)}}, headers={"X-User": "dev1"}).json()
    assert r["ok"] and r["run"]
    r2 = c.post("/api/unit-tests/run", json={"project": "p", "run": "again", "repo": {"dir": str(tmp_path)}}).json()
    assert r2["run"] == "again"
    lc = c.get("/api/lifecycle?project=p").json()
    assert lc["requirements"][0]["unit"]["runs"] == 2
    acts = [a["action"] for a in c.get("/api/logs/user_actions?project=p").json()["rows"]]
    assert "run-unit-tests" in acts
