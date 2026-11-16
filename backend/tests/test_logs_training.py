"""Logs, masking, batched writes, training, KPIs, TMMI and the unit-test connectors."""
import json
import os
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from phoenix_api import analytics, kpi, logmask, logstore, test_connectors as tc, tmmi, training
from phoenix_api.app import create_app
from phoenix_api.service import Deps


# ---- masking
def test_mask_hides_secrets_numbers_emails_phones():
    t = logmask.mask('password=hunter2 Bearer abcdefgh12345678 key sk-abcdefghijklmnop1234 card 4111 1111 1111 1111 mail a@b.com call +65 9123 4567 api_key: "zzz"')
    for leaked in ("hunter2", "abcdefgh12345678", "sk-abcdefghijklmnop1234", "4111", "a@b.com", "9123 4567", "zzz"):
        assert leaked not in t
    assert "[secret]" in t and "[email]" in t and "[number]" in t


# ---- store, read, never raise, training capture is opt-in
def test_record_and_read_by_project_with_masking():
    assert logstore.record("agent_event", {"project": "p1", "agent": "runner", "event": "x", "status": "ok", "ms": "12", "detail": "token=abc123456"})
    logstore.record("agent_event", {"project": "p2", "agent": "runner", "event": "y", "status": "ok"})
    rows = logstore.read("agent_events", "p1")
    assert len(rows) == 1 and rows[0]["ms"] == 12 and "abc123456" not in rows[0]["detail"]
    assert logstore.record("nonsense", {}) is False
    with pytest.raises(ValueError):
        logstore.read("passwords")


def test_training_examples_only_when_capture_is_on_and_are_masked(monkeypatch):
    assert logstore.record("training_example", {"prompt": "hi", "response": "yo"}, {}) is False
    env = {"PHOENIX_TRAIN_CAPTURE": "1"}
    assert logstore.record("training_example", {"prompt": "my password: secret99 mail a@b.com", "response": "ok"}, env)
    r = logstore.read("training_examples")[0]
    assert "secret99" not in r["prompt"] and "a@b.com" not in r["prompt"] and r["split"] in ("train", "eval") and r["outcome"] == "unknown"


def test_split_is_stable_for_the_same_prompt():
    assert logstore.hash_bucket("same") == logstore.hash_bucket("same")


# ---- batched writer and spool
class FakeCH:
    def __init__(self, fail=False):
        self.fail, self.calls, self.rows = fail, 0, {}

    def command(self, *a, **k):
        pass

    def insert(self, table, data, column_names=None):
        self.calls += 1
        if self.fail:
            raise RuntimeError("down")
        self.rows.setdefault(table, []).extend(data)

    def query(self, *a, **k):
        raise AssertionError("not used")


def test_writes_are_batched_one_insert_per_table(tmp_path):
    ch = FakeCH()
    a = analytics.Analytics(env={"PHOENIX_LOG_SPOOL_DIR": str(tmp_path)}, client=ch)
    for i in range(50):
        logstore.record("agent_event", {"agent": "runner", "event": "e", "status": "ok"}, a=a)
    assert ch.calls == 0  # nothing written per event
    assert a.flush() == 50 and ch.calls == 1 and len(ch.rows["agent_events"]) == 50
    a.close()


def test_failed_flush_spools_and_replays(tmp_path):
    ch = FakeCH(fail=True)
    a = analytics.Analytics(env={"PHOENIX_LOG_SPOOL_DIR": str(tmp_path)}, client=ch)
    logstore.record("mcp_call", {"tool": "list_agents", "status": "ok", "ms": 3}, a=a)
    a.flush()
    assert os.path.exists(tmp_path / "mcp_calls.jsonl") and not ch.rows
    ch.fail = False
    a.flush()
    assert len(ch.rows["mcp_calls"]) == 1 and not os.path.exists(tmp_path / "mcp_calls.jsonl")
    a.close()


# ---- training
def _fill(n, outcome="good", env=None):
    env = env or {"PHOENIX_TRAIN_CAPTURE": "1"}
    for i in range(n):
        logstore.record("training_example", {"project": "p", "source": "triage", "prompt": f"prompt {i}", "response": f"answer {i}", "outcome": outcome}, env)


def test_export_keeps_good_dedupes_and_makes_preference_pairs(tmp_path):
    env = {"PHOENIX_TRAIN_CAPTURE": "1", "PHOENIX_DATA_DIR": str(tmp_path)}
    _fill(30, "good", env)
    for i in range(5):
        logstore.record("training_example", {"prompt": f"bad prompt {i}", "response": "x", "outcome": "bad"}, env)
    logstore.record("training_example", {"prompt": "fix me", "response": "wrong", "outcome": "unknown"}, env)
    logstore.record("training_example", {"prompt": "fix me", "response": "wrong", "outcome": "corrected", "preferred": "right"}, env)  # the label overrides the capture
    out = training.export(None, env)
    assert out["train"] + out["eval"] == 31 and out["prefs"] == 1
    prefs = [json.loads(x) for x in open(os.path.join(out["dir"], "prefs.jsonl"))]
    assert prefs[0]["chosen"] == "right" and prefs[0]["rejected"] == "wrong"
    train = [json.loads(x) for x in open(os.path.join(out["dir"], "train.jsonl"))]
    assert all(m["messages"][1]["role"] == "assistant" for m in train)


def test_cannot_train_with_too_few_examples(tmp_path):
    env = {"PHOENIX_TRAIN_CAPTURE": "1", "PHOENIX_DATA_DIR": str(tmp_path)}
    _fill(10, "good", env)
    with pytest.raises(ValueError, match="at least"):
        training.start(None, "ann", env=env)


def test_gate_and_four_eyes_promotion(tmp_path):
    env = {"PHOENIX_TRAIN_CAPTURE": "1", "PHOENIX_DATA_DIR": str(tmp_path), "PHOENIX_TRAIN_MIN_EXAMPLES": "5"}
    _fill(60, "good", env)
    j = training.start(None, "ann", env=env, launch=False)
    assert j["status"] == "queued" and "qlora_train.py" in j["command"]
    r = training.report(j["id"], {"status": "finished", "metrics": {"tuned_score": 0.9, "live_score": 0.7, "tuned_valid": 0.99}}, env)
    assert r["status"] == "ready-for-review" and r["gate"]["passed"]
    with pytest.raises(ValueError, match="four eyes"):
        training.promote(j["id"], "ann", "looks right to me", env)
    with pytest.raises(ValueError, match="why"):
        training.promote(j["id"], "bob", "ok", env)
    p = training.promote(j["id"], "bob", "beats the live model by 0.2 on held-out", env)
    assert p["status"] == "promoted" and training.list_jobs(env)["live"]["by"] == "bob"


def test_gate_rejects_a_model_that_does_not_beat_the_live_one():
    g = training.gate({"tuned_score": 0.7, "live_score": 0.7, "tuned_valid": 1})
    assert not g["passed"] and "does not beat" in g["reasons"][0]
    assert not training.gate({"tuned_score": 0.9, "live_score": 0.5, "tuned_valid": 0.5})["passed"]


def test_a_failed_gate_cannot_be_promoted(tmp_path):
    env = {"PHOENIX_TRAIN_CAPTURE": "1", "PHOENIX_DATA_DIR": str(tmp_path), "PHOENIX_TRAIN_MIN_EXAMPLES": "5"}
    _fill(60, "good", env)
    j = training.start(None, "ann", env=env, launch=False)
    training.report(j["id"], {"status": "finished", "metrics": {"tuned_score": 0.5, "live_score": 0.6, "tuned_valid": 1}}, env)
    with pytest.raises(ValueError, match="did not pass"):
        training.promote(j["id"], "bob", "promote it anyway please", env)


# ---- KPIs, leakage, TMMI
def _results():
    for i, (v, f) in enumerate([("passed", 0), ("passed", 0), ("failed", 0), ("passed", 1), ("blocked-by-site", 0)]):
        logstore.record("release_result", {"project": "p", "run": "r1", "case_id": f"C{i}", "verdict": v, "flaky": f, "seconds": 10 + i})


def test_kpis_from_release_results():
    _results()
    r = kpi.report("p")
    k = r["kpis"]
    assert k["caseRuns"] == 5 and k["passRate"] == 0.75 and k["flakyRate"] == 0.2 and k["blockedBySiteRate"] == 0.2 and k["releases"] == 1


def test_no_defect_data_means_none_not_zero():
    q = kpi.report("empty")["quality"]
    assert q["defectLeakage"] is None and q["unitTestLeakage"] is None and "No defects have been logged" in q["note"]


def test_defect_leakage_ddp_and_unit_test_leakage():
    for key, phase, ut in [("D1", "unit", 0), ("D2", "system", 1), ("D3", "system", 0), ("D4", "uat", 1), ("D5", "production", 1), ("D5", "production", 1)]:  # D5 twice counts once
        logstore.record("defect", {"project": "p", "dkey": key, "found_in": phase, "unit_testable": ut})
    q = kpi.report("p")["quality"]
    assert q["defectsLogged"] == 5 and q["byPhase"]["production"] == 1
    assert q["defectLeakage"] == 0.2 and q["defectDetectionPercentage"] == 0.8
    assert q["unitTestableDefects"] == 3 and q["unitTestLeakage"] == 1.0  # all three unit-testable defects were found after the unit phase
    assert q["phaseLeakage"]["unit"] == 0.8


def test_tmmi_is_indicative_and_never_skips_levels():
    _results()
    t = kpi.report("p")["tmmi"]
    assert t["achieved"] == 1 and "Indicative" in t["note"]
    assert set(t["levels"]) == {2, 3, 4, 5} and t["nextSteps"]
    assert all(v["rating"] in "NPLF" for lv in t["levels"].values() for v in lv["areas"].values())
    assert tmmi._rate(0.9) == "F" and tmmi._rate(0.1) == "N"


# ---- connectors
JUNIT = '<testsuite><testcase classname="a.B" name="PROJ-12 adds" time="0.5"/><testcase classname="a.B" name="fails"><failure/></testcase><testcase name="s"><skipped/></testcase></testsuite>'


def test_junit_parser_finds_requirement_keys():
    t = tc.parse_junit(JUNIT)
    assert [x["status"] for x in t] == ["passed", "failed", "skipped"] and t[0]["requirement"] == "PROJ-12" and t[0]["ms"] == 500
    s = tc.summarize(t)
    assert s["passRate"] == 0.5 and s["requirements"] == ["PROJ-12"]


def test_go_and_trx_parsers():
    g = tc.parse_go_json('{"Action":"pass","Package":"p","Test":"TestREQ_3","Elapsed":0.1}\n{"Action":"fail","Package":"p","Test":"TestB"}\nnoise\n')
    assert [x["status"] for x in g] == ["passed", "failed"] and g[0]["requirement"] == "REQ-3"
    x = tc.parse_trx('<TestRun xmlns="http://x"><Results><UnitTestResult testName="A PROJ-1" outcome="Passed"/><UnitTestResult testName="B" outcome="Failed"/></Results></TestRun>')
    assert [y["status"] for y in x] == ["passed", "failed"]


def test_every_language_has_a_command_and_php_and_java_are_there():
    assert "php" in tc.LANGUAGES and "java" in tc.LANGUAGES
    for lang in tc.LANGUAGES:
        for kind in tc.KINDS:
            argv, _, parser = tc.command(lang, kind, "/tmp/x.xml")
            assert argv and parser
    assert "integration" in " ".join(tc.command("python", "integration", "/tmp/x.xml")[0])
    assert "--group" in tc.command("php", "integration", "/tmp/x.xml")[0]


def test_run_tests_with_a_fake_runner_and_missing_toolchain(tmp_path):
    def fake_run(argv, cwd=None, **k):
        out = next(a.split("=", 1)[1] for a in argv if a.startswith("--junitxml="))
        open(out, "w").write(JUNIT)
        return type("P", (), {"returncode": 1, "stdout": "", "stderr": ""})()
    r = tc.run_tests("python", "unit", str(tmp_path), run=fake_run, which=lambda t: "/bin/" + t)
    assert r["available"] and not r["ok"] and r["summary"]["failed"] == 1 and r["tests"][0]["requirement"] == "PROJ-12"
    m = tc.run_tests("java", "unit", str(tmp_path), run=fake_run, which=lambda t: None)
    assert m["available"] is False and "not installed" in m["detail"]
    with pytest.raises(ValueError):
        tc.run_tests("cobol", "unit", str(tmp_path))


def test_detects_languages_from_the_repo(tmp_path):
    (tmp_path / "composer.json").write_text("{}")
    (tmp_path / "pom.xml").write_text("<project/>")
    (tmp_path / "go.mod").write_text("module x")
    assert set(tc.detect_languages(str(tmp_path))) == {"php", "java", "go"}


def test_clone_only_https(tmp_path):
    with pytest.raises(ValueError):
        tc.clone("git@github.com:a/b.git")


# ---- API
def _client():
    return TestClient(create_app(Deps(env={"PHOENIX_TRAIN_CAPTURE": "1"})))


def test_api_ingest_logs_kpi_label_and_defects():
    c = _client()
    r = c.post("/api/ingest", json={"events": [{"kind": "agent_event", "row": {"project": "p", "agent": "triage", "event": "model-call", "status": "ok", "ms": 5}}, {"kind": "bogus", "row": {}}]})
    assert r.json() == {"stored": 1, "received": 2, "backend": "memory"}
    assert c.get("/api/logs/agent_events?project=p").json()["rows"][0]["agent"] == "triage"
    assert c.get("/api/logs/secrets").status_code == 400
    assert c.get("/api/kpi?project=p").json()["kpis"]["modelCalls"] == 1
    assert c.post("/api/defects", json={"project": "p", "key": "X-1", "foundIn": "production"}).json()["stored"]
    assert c.post("/api/defects", json={"foundIn": "nowhere"}).status_code == 400
    assert c.post("/api/training/label", json={"prompt": "a", "outcome": "good"}).status_code == 400  # needs a person
    assert c.post("/api/training/label", json={"prompt": "a", "response": "b", "outcome": "good"}, headers={"X-User": "ann"}).json()["stored"]
    assert c.post("/api/training/label", json={"prompt": "a", "outcome": "corrected"}, headers={"X-User": "ann"}).status_code == 400
    assert c.get("/api/training/status").json()["stats"]["usable"] == 1


def test_api_ingest_token_is_enforced_when_set():
    c = TestClient(create_app(Deps(env={"PHOENIX_INGEST_TOKEN": "t0k"})))
    assert c.post("/api/ingest", json={"events": []}).status_code == 401
    assert c.post("/api/ingest", json={"events": []}, headers={"X-Ingest-Token": "t0k"}).status_code == 200
