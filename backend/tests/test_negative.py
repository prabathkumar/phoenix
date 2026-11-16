"""Negative testing: invalid, hostile and broken input must be refused or handled, never crash, leak a secret, run foreign code or skip a human decision."""
import asyncio
import json
import os

import pytest
from fastapi.testclient import TestClient

from phoenix_api import handlers as H, kpi, logmask, logstore, test_connectors as tc, training
from phoenix_api.app import create_app
from phoenix_api.service import Deps

run = asyncio.run


def client(env=None, **kw):
    return TestClient(create_app(Deps(env=env or {}, **kw)), raise_server_exceptions=False)


# ---------- ingest: garbage in, no 500s, nothing dangerous stored
@pytest.mark.parametrize("body", [
    {"events": "not a list"}, {"events": [None, 5, "x", [], {}]}, {"events": [{"kind": "agent_event", "row": "string"}]},
    {"events": [{"kind": "agent_event", "row": ["a"]}]}, {"events": [{"kind": "agent_event", "row": {"ms": "NaN", "agent": {"a": 1}}}]},
    {"events": [{"kind": ["agent_event"], "row": {}}]}, {"kind": "agent_event"}, {},
])
def test_ingest_never_crashes_on_garbage(body):
    r = client().post("/api/ingest", json=body)
    assert r.status_code == 200, r.text


def test_ingest_rejects_non_json_and_huge_batches_are_capped():
    c = client()
    assert c.post("/api/ingest", content=b"{not json", headers={"content-type": "application/json"}).status_code in (400, 422)
    big = {"events": [{"kind": "agent_event", "row": {"agent": "a"}}] * 5000}
    assert c.post("/api/ingest", json=big).json()["received"] == 2000


def test_oversized_and_hostile_fields_are_truncated_and_stored_as_text():
    logstore.record("agent_event", {"project": "neg", "agent": "x" * 100000, "detail": "'; DROP TABLE agent_events;-- " + "y" * 100000, "ms": -5})
    r = logstore.read("agent_events", "neg")[0]
    assert len(r["agent"]) <= 200 and len(r["detail"]) <= 600 and r["ms"] == 0


def test_sql_injection_in_filters_is_inert():
    logstore.record("agent_event", {"project": "neg2", "agent": "a"})
    rows = logstore.read("agent_events", "neg2' OR '1'='1", filters={"agent": "a' OR 1=1 --"})
    assert rows == []
    assert logstore.read("agent_events", "neg2", filters={"detail; DROP": "x", "prompt": "x"})  # unknown / blocked filter names are ignored, not executed


def test_unknown_log_table_is_400():
    for t in ("passwords", "../etc/passwd", "agent_events;drop", "training_examples%00"):
        assert client().get(f"/api/logs/{t}").status_code in (400, 404)


def test_ingest_token_missing_or_wrong_is_401_everywhere_it_applies():
    c = client({"PHOENIX_INGEST_TOKEN": "s3cret"})
    for h in ({}, {"X-Ingest-Token": "nope"}, {"X-Ingest-Token": ""}):
        assert c.post("/api/ingest", json={"events": []}, headers=h).status_code == 401
        assert c.post("/api/training/jobs/tj-x/result", json={"status": "finished"}, headers=h).status_code == 401


# ---------- masking cannot be bypassed by common disguises
@pytest.mark.parametrize("text,leak", [
    ("PASSWORD = 'P@ssw0rd!2024'", "P@ssw0rd"), ('{"password":"hunter2","user":"a"}', "hunter2"), ("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghij", "eyJhbGci"),
    ("api-key=AKIAABCDEFGHIJKLMNOP", "AKIAABCD"), ("token: ghp_abcdefghijklmnopqrstuvwx", "ghp_abc"), ("cookie=sessionid=abc123def456", "abc123def456"),
    ("card 4111-1111-1111-1111", "4111"), ("mail me: Bob.Smith+x@Example.CO.uk", "Bob.Smith"), ("x-api-key: 0123456789abcdef", "0123456789abcdef"),
])
def test_masking_catches_disguised_secrets(text, leak):
    assert leak not in logmask.mask(text)


def test_masking_handles_non_strings_and_empty():
    assert logmask.mask(None) == "None" and logmask.mask(12345) == "12345" and logmask.mask("") == ""
    assert len(logmask.mask("a" * 100000, 50)) == 50


# ---------- training: every human gate holds
def _env(tmp_path, n=60):
    env = {"PHOENIX_TRAIN_CAPTURE": "1", "PHOENIX_DATA_DIR": str(tmp_path), "PHOENIX_TRAIN_MIN_EXAMPLES": "5"}
    for i in range(n):
        logstore.record("training_example", {"project": "negt", "prompt": f"np {i}", "response": f"na {i}", "outcome": "good"}, env)
    return env


def test_cannot_promote_unknown_unfinished_failed_or_by_nobody(tmp_path):
    env = _env(tmp_path)
    with pytest.raises(ValueError):
        training.promote("tj-nope", "bob", "a long enough reason", env)
    j = training.start("negt", "ann", env=env, launch=False)
    for who in ("", "unknown", None):
        with pytest.raises(ValueError):
            training.promote(j["id"], who, "a long enough reason", env)
    with pytest.raises(ValueError, match="did not pass"):  # still queued: no gate result
        training.promote(j["id"], "bob", "a long enough reason", env)
    training.report(j["id"], {"metrics": {"tuned_score": 0.99, "live_score": 0.1, "tuned_valid": 0.4}}, env)
    with pytest.raises(ValueError, match="did not pass"):  # high score but broken answers
        training.promote(j["id"], "bob", "a long enough reason", env)


def test_metrics_cannot_be_forged_by_the_trainer_to_skip_the_gate(tmp_path):
    env = _env(tmp_path)
    j = training.start("negt", "ann", env=env, launch=False)
    r = training.report(j["id"], {"status": "promoted", "gate": {"passed": True}, "promoted": {"by": "x"}, "metrics": {"tuned_score": 0.5, "live_score": 0.9, "tuned_valid": 1}}, env)
    assert r["status"] == "rejected-by-gate" and not r["gate"]["passed"] and not r.get("promoted")


def test_report_with_garbage_metrics_does_not_crash_or_pass(tmp_path):
    env = _env(tmp_path)
    j = training.start("negt", "ann", env=env, launch=False)
    with pytest.raises((ValueError, TypeError)):
        training.report(j["id"], {"metrics": {"tuned_score": "abc"}}, env)


def test_training_api_refuses_bad_requests(tmp_path):
    c = client({"PHOENIX_DATA_DIR": str(tmp_path), "PHOENIX_TRAIN_CAPTURE": "1"})
    assert c.post("/api/training/jobs", json={}).status_code == 400  # not enough data
    assert c.get("/api/training/jobs/tj-none").status_code == 404
    assert c.post("/api/training/jobs/tj-none/promote", json={"note": "long enough note"}, headers={"X-User": "bob"}).status_code == 400
    assert c.post("/api/training/jobs/tj-none/promote", json={"note": "long enough note"}).status_code == 400  # nobody signed in
    assert c.post("/api/training/jobs/tj-none/result", json={"status": "finished"}).status_code == 404
    for bad in ({"outcome": "great"}, {"outcome": ""}, {}):
        assert c.post("/api/training/label", json={"prompt": "p", **bad}, headers={"X-User": "ann"}).status_code == 400


def test_training_labels_when_capture_is_off_store_nothing():
    c = client({})
    r = c.post("/api/training/label", json={"prompt": "p", "response": "r", "outcome": "good"}, headers={"X-User": "ann"})
    assert r.json() == {"stored": False}


def test_a_secret_in_a_captured_prompt_never_reaches_the_dataset(tmp_path):
    env = {"PHOENIX_TRAIN_CAPTURE": "1", "PHOENIX_DATA_DIR": str(tmp_path)}
    logstore.record("training_example", {"project": "sec", "prompt": "login with password: Sup3rS3cret! and token=abcdef123456", "response": "ok", "outcome": "good"}, env)
    out = training.export("sec", env)
    data = "".join(open(os.path.join(out["dir"], f)).read() for f in ("train.jsonl", "eval.jsonl"))
    assert "Sup3rS3cret" not in data and "abcdef123456" not in data


# ---------- defects and KPIs
def test_defects_api_rejects_bad_phase_and_survives_odd_types():
    c = client()
    for b in ({}, {"foundIn": "prod"}, {"foundIn": None}, {"foundIn": ["production"]}):
        assert c.post("/api/defects", json=b).status_code in (400, 422)
    assert c.post("/api/defects", json={"foundIn": "unit", "unitTestable": "yes please", "severity": {"x": 1}}).status_code == 200


def test_kpis_with_nothing_logged_are_none_not_zero_or_errors():
    r = kpi.report("project-that-never-ran")
    assert r["kpis"]["passRate"] is None and r["quality"]["defectLeakage"] is None and r["tmmi"]["achieved"] == 1


# ---------- unit-test connectors: no foreign code, no escapes
@pytest.mark.parametrize("url", ["git@github.com:a/b.git", "file:///etc", "http://x/a/b", "https://x/a b", "https://x/a;rm -rf /", "-u https://x/a/b", "https://x/a/b --upload-pack=evil", "", None, "ext::sh -c id"])
def test_clone_refuses_anything_but_plain_https(url):
    with pytest.raises(ValueError):
        tc.clone(url)


def test_unit_run_refuses_a_folder_the_server_did_not_allow(tmp_path):
    (tmp_path / "pytest.ini").write_text("")
    (tmp_path / "test_x.py").write_text("import os\ndef test_x(): open('/tmp/phx-pwned','w').write('x')\n")
    r = run(H.unitrun_handler("p", "r", {})({"repoRequest": {"dir": str(tmp_path)}}))  # no PHOENIX_UNIT_ROOT configured
    assert r.get("unavailable") and "not allowed" in r["detail"].lower()
    assert not os.path.exists("/tmp/phx-pwned")
    for d in ("/", "/etc", "../..", "/root"):
        assert run(H.unitrun_handler("p", "r", {"PHOENIX_UNIT_ROOT": str(tmp_path)})({"repoRequest": {"dir": d}})).get("unavailable")


def test_unit_run_allows_only_inside_the_root_and_blocks_traversal(tmp_path):
    root = tmp_path / "ok"
    root.mkdir()
    (root / "pytest.ini").write_text("")
    (root / "test_a.py").write_text("def test_REQ_1(): pass\n")
    env = {"PHOENIX_UNIT_ROOT": str(root)}
    assert run(H.unitrun_handler("p", "r", env)({"repoRequest": {"dir": str(root)}}))["ok"]
    assert run(H.unitrun_handler("p", "r", env)({"repoRequest": {"dir": str(root) + "/../"}})).get("unavailable")
    link = tmp_path / "ln"
    os.symlink("/etc", link)
    assert run(H.unitrun_handler("p", "r", {"PHOENIX_UNIT_ROOT": str(tmp_path)})({"repoRequest": {"dir": str(link)}})).get("unavailable")


def test_unit_run_bad_language_kind_and_empty_folder(tmp_path):
    env = {"PHOENIX_UNIT_ROOT": str(tmp_path)}
    assert run(H.unitrun_handler("p", "r", env)({"repoRequest": {"dir": str(tmp_path)}})).get("unavailable")  # nothing detectable
    (tmp_path / "go.mod").write_text("module x")
    r = run(H.unitrun_handler("p", "r", env)({"repoRequest": {"dir": str(tmp_path), "languages": ["cobol", "../../x"]}}))
    assert r.get("unavailable")
    with pytest.raises(ValueError):
        tc.run_tests("go", "chaos", str(tmp_path))


def test_a_hanging_or_crashing_test_run_is_contained(tmp_path):
    import subprocess

    def boom(argv, **k): raise subprocess.TimeoutExpired(argv, 1)
    r = tc.run_tests("python", "unit", str(tmp_path), run=boom, which=lambda t: "/x")
    assert not r["ok"] and "timed out" in r["detail"]
    r = tc.run_tests("go", "unit", str(tmp_path), run=lambda *a, **k: (_ for _ in ()).throw(OSError("no exec")), which=lambda t: "/x")
    assert not r["ok"] and "no exec" in r["detail"]


def test_malformed_result_files_are_not_a_pass():
    assert tc.parse_junit("<not xml") == [] and tc.parse_trx("") == [] and tc.parse_go_json("garbage\n{\n") == []
    assert tc.summarize([])["passRate"] is None


def test_a_run_with_zero_tests_is_not_ok(tmp_path):
    (tmp_path / "pytest.ini").write_text("")
    r = tc.run_tests("python", "unit", str(tmp_path))
    assert not r["ok"] and r["tests"] == []


def test_generate_unit_tests_bad_inputs():
    c = client(call_json=None)
    assert c.post("/api/unit-tests/generate", json={"repo": {}}).json().get("unavailable")
    assert c.post("/api/unit-tests/generate", json={}).status_code in (200, 400, 422)

    async def model(p): return "no tests in here"

    class R:
        async def default_branch(self): return "main"
        async def list_files(self, ref): return ["src/a.py", "src/b.py"]
        async def read_file(self, p, ref): return "x = 1\n" if p == "src/a.py" else "y" * 50000
    r = run(H.unittests_handler(model, lambda n, p="s": {"text": "t"}, lambda rq: R())({"repoRequest": {"project": "o/r"}, "results": []}))
    assert not r["ok"] and len(r["data"]["skipped"]) == 2
    assert {s["why"] for s in r["data"]["skipped"]} >= {"file is too large to test in one go"}


def test_generated_test_with_syntax_error_or_wrong_framework_is_skipped():
    class R:
        async def default_branch(self): return "main"
        async def list_files(self, ref): return ["src/a.py"]
        async def read_file(self, p, ref): return "x = 1\n"
    for answer in ("def test_x(:\n  pass", "console.log('not python')", ""):
        async def model(p, a=answer): return a
        r = run(H.unittests_handler(model, lambda n, p="s": {"text": "t"}, lambda rq: R())({"repoRequest": {"project": "o/r"}, "results": []}))
        assert not r["ok"] and r["data"]["skipped"], answer


def test_a_model_that_raises_does_not_break_generation():
    class R:
        async def default_branch(self): return "main"
        async def list_files(self, ref): return ["src/a.py"]
        async def read_file(self, p, ref): return "x = 1\n"

    async def model(p): raise RuntimeError("model down")
    r = run(H.unittests_handler(model, lambda n, p="s": {"text": "t"}, lambda rq: R())({"repoRequest": {"project": "o/r"}, "results": []}))
    assert not r["ok"] and "model down" in r["data"]["skipped"][0]["why"]


# ---------- the gateway never stores text unless capture is on
def test_capture_off_means_no_prompt_text_is_stored():
    assert logstore.record("training_example", {"prompt": "secret plan", "response": "x"}, {}) is False
    assert logstore.record("training_example", {"prompt": "p"}, {"PHOENIX_TRAIN_CAPTURE": "0"}) is False
