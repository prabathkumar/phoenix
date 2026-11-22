import json
import subprocess
import sys

from fastapi.testclient import TestClient  # noqa: F401  (used through test_release_events.app)

from phoenix_mcp import server as S
from tests.test_release_events import KEY, app


def adapter(c):
    def call(method, path, body=None):
        r = c.request(method, path, json=body, headers={"Authorization": f"Bearer {KEY}"})
        if r.status_code >= 400:
            raise S.ApiError(f"{r.status_code}: {r.json().get('detail')}")
        return r.json()
    return call


def tool(srv, name, args, i=1):
    out = srv.handle({"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"name": name, "arguments": args}})["result"]
    return out["isError"], json.loads(out["content"][0]["text"]) if not out["isError"] else out["content"][0]["text"]


def test_protocol_handshake_and_tool_list():
    srv = S.Server(call=lambda *a, **k: {})
    init = srv.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}})["result"]
    assert init["protocolVersion"] == "2025-03-26" and init["serverInfo"]["name"] == "testops-ai"
    assert srv.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    names = {t["name"] for t in srv.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})["result"]["tools"]}
    assert {"testops_start_release", "testops_run_unit_tests", "testops_run_scans", "testops_get_status", "testops_get_evidence"} <= names
    assert "error" in srv.handle({"jsonrpc": "2.0", "id": 3, "method": "nope"})
    assert "error" in srv.handle({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "nope"}})


def test_a_tool_call_runs_the_agent_through_the_release_api():
    with app() as c:
        srv = S.Server(call=adapter(c), sleep=lambda s: None)
        err, res = tool(srv, "testops_send_event", {"agent": "scout", "action": "write-scenarios", "release": "R2026.11.3", "requirement": "Users can log in with a password.", "wait": True})
        assert not err and res["status"] in ("passed", "needs-you", "failed")
        err, art = tool(srv, "testops_get_evidence", {"id": res["id"]})
        assert not err and "scenarios" in json.dumps(art)
        err, st = tool(srv, "testops_get_status", {"id": res["id"]})
        assert not err and st["id"] == res["id"]
        assert not tool(srv, "testops_list_actions", {})[0]


def test_unit_tests_need_a_requirement_and_the_refusal_is_plain():
    with app() as c:
        srv = S.Server(call=adapter(c))
        err, text = tool(srv, "testops_run_unit_tests", {"project": "shop", "repo": {"provider": "github", "project": "org/app"}})
        assert err and "refused or failed" in text


def test_unit_tests_use_the_forge_steps_and_scans_use_the_warden():
    sent = []
    srv = S.Server(call=lambda m, p, b=None: sent.append(b) or {"id": "e1", "status": "queued"})
    assert tool(srv, "testops_run_unit_tests", {"release": "1", "jiraKey": "SHP-1", "repo": {"provider": "github", "project": "o/a"}})[1]["id"] == "e1"
    tool(srv, "testops_run_scans", {"release": "1", "repo": {"provider": "github", "project": "o/a"}})
    tool(srv, "testops_start_release", {"release": "1", "requirement": "x"})
    assert [s["action"] for s in sent[0]["steps"]] == ["link-repo", "write-unit-tests", "run-unit-tests"] and sent[0]["jiraKey"] == "SHP-1"
    assert sent[1]["steps"] == [{"agent": "warden", "action": "scan"}]
    assert sent[2]["agent"] == "team" and sent[2]["action"] == "release"


def test_missing_settings_say_what_to_set(monkeypatch):
    monkeypatch.delenv("PHOENIX_URL", raising=False)
    monkeypatch.delenv("PHOENIX_API_KEY", raising=False)
    err, text = tool(S.Server(), "testops_list_actions", {})
    assert err and "PHOENIX_URL" in text


def test_stdio_round_trip():
    msgs = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}, {"jsonrpc": "2.0", "method": "notifications/initialized"}, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}]
    p = subprocess.run([sys.executable, "-m", "phoenix_mcp.server"], input="\n".join(json.dumps(m) for m in msgs) + "\nnot json\n", capture_output=True, text=True, timeout=30)
    lines = [json.loads(x) for x in p.stdout.splitlines()]
    assert len(lines) == 3 and lines[1]["result"]["tools"] and lines[2]["error"]["code"] == -32700
