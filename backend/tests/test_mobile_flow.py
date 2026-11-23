import subprocess
import sys

from phoenix_api import mobile_flow as m


def test_draft_filters_bad_actions_and_marks_gaps():
    cs = m.draft_cases([{"key": "R1"}, {"key": "R2"}], "android", "a.apk", call_json=lambda t: {"cases": [
        {"requirement": "R1", "steps": [{"action": "tap", "locator": "login"}, {"action": "rm -rf", "locator": "x"}], "expected": "ok"}]})
    by = {c["requirement"]: c for c in cs}
    assert [s["action"] for s in by["R1"]["steps"]] == ["tap"] and by["R2"]["source"].startswith("draft")


def test_capabilities():
    assert m.capabilities("ios", "a.ipa")["appium:automationName"] == "XCUITest"
    assert m.capabilities("android", "a.apk", "Pixel 8")["appium:deviceName"] == "Pixel 8"


def test_submit_needs_grid_and_uses_env_url():
    assert not m.submit([], "android", "a.apk", "", None, {})["available"]
    seen = {}
    r = m.submit([{"requirement": "R1"}], "android", "a.apk", "", lambda u, j: seen.update(u=u) or {"id": "j1"}, {"PHOENIX_MOBILE_URL": "http://grid/"})
    assert r["ok"] and seen["u"] == "http://grid/jobs"
    def boom(u, j): raise TimeoutError()
    assert not m.submit([], "android", "a", "", boom, {"APPIUM_URL": "http://g"})["ok"]


def test_generated_file_compiles_and_skips_without_grid(tmp_path):
    src = m.to_pytest(m.draft_cases([{"key": "R1"}]), "android", "a.apk")
    compile(src, "gen", "exec")
