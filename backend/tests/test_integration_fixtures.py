"""Real integration runs against tiny fixture projects that follow each language's convention."""
import os, shutil
import pytest
from phoenix_api import test_connectors as T

FX = os.path.join(os.path.dirname(__file__), "fixtures", "integration")


@pytest.mark.skipif(not shutil.which("python3"), reason="python3 missing")
def test_python_integration_runs_only_the_marked_test():
    r = T.run_tests("python", "integration", os.path.join(FX, "py"))
    assert r["ok"] and [t["name"] for t in r["tests"]] == ["test_calc test_add_integration"]


@pytest.mark.skipif(not shutil.which("go"), reason="go missing")
def test_go_integration_uses_the_build_tag():
    assert len(T.run_tests("go", "unit", os.path.join(FX, "go"))["tests"]) == 1
    r = T.run_tests("go", "integration", os.path.join(FX, "go"))
    assert r["ok"] and any("Integration" in t["name"] for t in r["tests"])


def test_a_test_that_fails_then_passes_is_flagged_flaky_and_a_double_failure_stays_failed(tmp_path):
    import json
    calls = []

    def fake(argv, **kw):
        calls.append(1)
        ev = lambda i, n, r: [json.dumps({"type": "testStart", "test": {"id": i, "name": n}}), json.dumps({"type": "testDone", "testID": i, "result": r})]
        lines = ev(1, "a", "error" if len(calls) == 1 else "success") + ev(2, "b", "error")
        return type("P", (), {"returncode": 1, "stdout": "\n".join(lines), "stderr": ""})()

    (tmp_path / "pubspec.yaml").write_text("name: x\n")
    r = T.run_tests("dart", "unit", str(tmp_path), run=fake, which=lambda t: "/bin/" + t)
    st = {t["name"]: t for t in r["tests"]}
    assert st["a"]["status"] == "passed" and st["a"]["flaky"] and st["b"]["status"] == "failed"
    assert r["summary"]["flaky"] == 1 and not r["ok"] and len(calls) == 2


def test_model_picks_flaky_failure_it_is_rerun_and_the_pair_is_stored_as_a_training_example(tmp_path, monkeypatch):
    import asyncio, json
    from phoenix_api import triage as H
    stored, runs = [], []

    def fake_run_tests(lang, kind, root, **kw):
        runs.append(kw.get("retry"))
        t = [{"name": "a", "status": "passed", "ms": 1, "requirement": ""}]
        return {"language": lang, "kind": kind, "ok": True, "available": True, "detail": "", "tests": t, "summary": T.summarize(t)}

    monkeypatch.setattr(T, "run_tests", fake_run_tests)
    tests = [{"name": "a", "status": "failed", "ms": 1, "requirement": ""}, {"name": "b", "status": "failed", "ms": 1, "requirement": ""}]
    res = [{"language": "dart", "kind": "unit", "ok": False, "available": True, "detail": "x", "tests": tests, "summary": T.summarize(tests), "log": "timed out waiting"}]

    async def model(prompt):
        return {"failures": [{"name": "a", "verdict": "flaky", "rerun": True, "reason": "timing"}, {"name": "b", "verdict": "code_bug", "rerun": False, "reason": "wrong value"}]}

    asyncio.run(H.triage_and_rerun(res, str(tmp_path), model, "p", {}, record=lambda k, r: stored.append((k, r))))
    st = {t["name"]: t for t in res[0]["tests"]}
    assert st["a"]["status"] == "passed" and st["a"]["flaky"] and st["b"]["status"] == "failed"
    assert runs == [False] and [k for k, _ in stored] == ["training_example"] and stored[0][1]["outcome"] == "verified"


@pytest.mark.skipif(not shutil.which("cargo"), reason="cargo missing")
def test_rust_unit_leaves_out_integration_files_and_integration_runs_only_them():
    u = T.run_tests("rust", "unit", os.path.join(FX, "rust"), retry=False)
    i = T.run_tests("rust", "integration", os.path.join(FX, "rust"), retry=False)
    assert [t["name"] for t in u["tests"]] == ["tests::add_unit"] and [t["name"] for t in i["tests"]] == ["add_integration"]


@pytest.mark.skipif(not (shutil.which("prove") and shutil.which("perl")), reason="perl missing")
def test_perl_unit_and_integration_are_separate():
    u = T.run_tests("perl", "unit", os.path.join(FX, "perl"), retry=False)
    i = T.run_tests("perl", "integration", os.path.join(FX, "perl"), retry=False)
    assert [t["name"] for t in u["tests"]] == ["add unit"] and [t["name"] for t in i["tests"]] == ["add integration"]


@pytest.mark.skipif(not shutil.which("node"), reason="node missing")
def test_node_unit_leaves_out_integration_files():
    u = T.run_tests("javascript", "unit", os.path.join(FX, "js"), retry=False)
    i = T.run_tests("javascript", "integration", os.path.join(FX, "js"), retry=False)
    assert [t["name"] for t in u["tests"]] == ["test add unit"] and [t["name"] for t in i["tests"]] == ["test add integration"]
