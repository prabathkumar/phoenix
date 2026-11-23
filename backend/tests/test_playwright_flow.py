import os
import pytest

from phoenix_api import playwright_flow as p


def test_draft_marks_gaps():
    cs = p.draft_cases([{"key": "R1"}, {"key": "R2"}], call_json=lambda t: {"cases": [{"requirement": "R1", "url": "/a", "steps": [], "mock_api": []}]})
    by = {c["requirement"]: c for c in cs}
    assert by["R1"]["source"] == "model" and by["R2"]["source"].startswith("draft")


def test_build_spec_has_mock_and_steps():
    s = p.build_spec([{"requirement": "R1", "url": "/x", "steps": [{"action": "fill", "selector": "#a", "value": "v"}, {"action": "bogus"}],
                       "mock_api": [{"url_glob": "**/api/**", "status": 201, "body": {"ok": True}}]}])
    assert "page.route" in s and "status: 201" in s and "page.fill" in s and "unknown step skipped" in s


def test_parse_report():
    rep = {"suites": [{"specs": [{"title": "a", "tests": [{"results": [{"status": "passed"}]}]},
                                 {"title": "b", "tests": [{"results": [{"status": "failed", "error": {"message": "boom"}}]}]}]}]}
    r = p.parse(rep)
    assert r["summary"] == {"passed": 1, "failed": 1, "total": 2} and r["tests"][1]["error"] == "boom"


@pytest.mark.skipif(not os.environ.get("PHOENIX_PLAYWRIGHT_CMD"), reason="set PHOENIX_PLAYWRIGHT_CMD (and NODE_PATH) to run a real browser")
def test_real_run(tmp_path):
    (tmp_path / "page.html").write_text('<input id=a><button id=b onclick="fetch(\'https://api.test/x\').then(r=>r.json()).then(j=>document.getElementById(\'o\').textContent=j.msg)">go</button><div id=o></div>')
    cs = [{"requirement": "R1", "url": "file://" + str(tmp_path / "page.html"), "steps": [{"action": "click", "selector": "#b"}, {"action": "expect_text", "selector": "#o", "value": "hello"}],
           "mock_api": [{"url_glob": "https://api.test/**", "status": 200, "body": {"msg": "hello"}}]}]
    p.write_project(str(tmp_path), cs)
    assert p.run_specs(str(tmp_path))["ok"]
