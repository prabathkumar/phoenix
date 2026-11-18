import json
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from phoenix_api import runner_hub as R
from phoenix_api.app import create_app
from phoenix_api.service import Deps

U = {"X-User": "ann@ytl.com"}


@pytest.fixture
def c(tmp_path):
    return TestClient(create_app(Deps(env={"PHOENIX_DATA_DIR": str(tmp_path), "PHOENIX_ADMINS": "boss@ytl.com"})))


def paired(c, allow=("*.corp.example.com", "10.20.0.0/16")):
    code = c.post("/api/runners/pair", json={"name": "ann laptop", "allow": list(allow)}, headers=U).json()["code"]
    return c.post("/api/runners/register", json={"code": code, "name": "mac", "os": "darwin"}).json()


def test_allowlist_rules():
    a = ["*.corp.example.com", "intranet.local", "10.20.0.0/16"]
    assert R.allowed("https://crm.corp.example.com", a) and R.allowed("http://10.20.1.1", a) and R.allowed("http://intranet.local:8080", a)
    assert not R.allowed("https://corp.example.com", a) and not R.allowed("https://x.corp.example.com.evil.com", a) and not R.allowed("http://10.21.0.1", a)
    assert not R.allowed("http://169.254.169.254/", ["169.254.0.0/16"]) and not R.allowed("file:///etc/passwd", a) and not R.allowed("https://u:p@crm.corp.example.com", a) and not R.allowed("https://crm.corp.example.com", [])
    assert all(R.bad_pattern(p) for p in ["*", "*.com", "0.0.0.0/0", "10.0.0.0/4", "", "*.corp"])


def test_pairing_is_signed_in_single_use_and_refuses_wide_patterns(c):
    assert c.post("/api/runners/pair", json={"allow": ["*.corp.example.com"]}).status_code == 401
    assert c.post("/api/runners/pair", json={"allow": ["*"]}, headers=U).status_code == 400
    assert c.post("/api/runners/pair", json={"allow": []}, headers=U).status_code == 400
    code = c.post("/api/runners/pair", json={"allow": ["*.corp.example.com"]}, headers=U).json()["code"]
    assert c.post("/api/runners/register", json={"code": "WRNG-CODE"}).status_code == 400
    ok = c.post("/api/runners/register", json={"code": code, "name": "mac"})
    assert ok.status_code == 200 and ok.json()["token"] and ok.json()["allow"] == ["*.corp.example.com"]
    assert c.post("/api/runners/register", json={"code": code}).status_code == 400      # used once
    raw = open(c.app.state.runner_hub.path).read()
    assert ok.json()["token"] not in raw                                                # only a hash is kept


def test_a_bad_token_cannot_connect(c):
    paired(c)
    with pytest.raises(WebSocketDisconnect):
        with c.websocket_connect("/api/runners/connect", headers={"Authorization": "Bearer nope"}) as w:
            w.send_text(json.dumps({"type": "auth", "token": "nope"}))
            w.receive_text()


def test_first_message_auth_for_browser_extensions(c):
    r = paired(c)
    with c.websocket_connect("/api/runners/connect") as w:
        w.send_text(json.dumps({"type": "auth", "token": r["token"]}))
        w.send_text(json.dumps({"type": "ping"}))
        assert c.get("/api/runners", headers=U).json()["runners"][0]["online"] is True
    with pytest.raises(WebSocketDisconnect):
        with c.websocket_connect("/api/runners/connect") as w:
            w.send_text(json.dumps({"type": "hello"}))      # no auth message: refused
            w.receive_text()


def test_job_round_trip_and_ownership_and_allowlist(c):
    r = paired(c)
    h = {"Authorization": "Bearer " + r["token"]}
    steps = [{"kind": "navigate", "url": "https://crm.corp.example.com/login", "instruction": "Open the CRM"}]
    assert c.post(f"/api/runners/{r['runnerId']}/jobs", json={"kind": "web-case", "steps": steps}, headers=U).status_code == 409    # offline
    with c.websocket_connect("/api/runners/connect", headers=h) as rw:
        assert c.get("/api/runners", headers=U).json()["runners"][0]["online"] is True
        assert c.post(f"/api/runners/{r['runnerId']}/jobs", json={"kind": "web-case", "steps": steps}, headers={"X-User": "bob@ytl.com"}).status_code == 403
        out = [{"kind": "navigate", "url": "https://evil.example.org/", "instruction": "x"}]
        assert c.post(f"/api/runners/{r['runnerId']}/jobs", json={"kind": "web-case", "steps": out}, headers=U).status_code == 400
        assert c.post(f"/api/runners/{r['runnerId']}/jobs", json={"kind": "live", "url": "http://169.254.169.254/"}, headers=U).status_code == 400
        jid = c.post(f"/api/runners/{r['runnerId']}/jobs", json={"kind": "web-case", "steps": steps, "baseUrl": "https://crm.corp.example.com"}, headers=U).json()["jobId"]
        job = json.loads(rw.receive_text())
        assert job["type"] == "job" and job["id"] == jid and job["steps"] == steps
        assert c.post(f"/api/runners/{r['runnerId']}/jobs", json={"kind": "web-case", "steps": steps}, headers=U).status_code == 409   # busy
        rw.send_text(json.dumps({"type": "job-result", "id": jid, "result": {"success": True, "status": "passed"}}))
        rw.send_text(json.dumps({"type": "ping"}))
        j = c.get(f"/api/runners/jobs/{jid}", headers=U).json()
        assert j["status"] == "done" and j["result"]["status"] == "passed"
        assert c.get(f"/api/runners/jobs/{jid}", headers={"X-User": "bob@ytl.com"}).status_code == 404


def test_live_view_is_relayed_with_a_one_time_ticket(c):
    r = paired(c)
    with c.websocket_connect("/api/runners/connect", headers={"Authorization": "Bearer " + r["token"]}) as rw:
        made = c.post(f"/api/runners/{r['runnerId']}/jobs", json={"kind": "live", "url": "https://crm.corp.example.com"}, headers=U).json()
        jid, tk = made["jobId"], made["viewTicket"]
        assert json.loads(rw.receive_text())["kind"] == "live"
        with pytest.raises(WebSocketDisconnect):
            with c.websocket_connect(f"/api/runners/jobs/{jid}/view?ticket=wrong"):
                pass
        with c.websocket_connect(f"/api/runners/jobs/{jid}/view?ticket={tk}") as vw:
            rw.send_text(json.dumps({"type": "live-out", "id": jid, "data": '{"type":"frame"}'}))
            assert vw.receive_text() == '{"type":"frame"}'
            vw.send_text('{"type":"tap","xRatio":0.5,"yRatio":0.5}')
            back = json.loads(rw.receive_text())
            assert back == {"type": "live-in", "id": jid, "data": '{"type":"tap","xRatio":0.5,"yRatio":0.5}'}
        with pytest.raises(WebSocketDisconnect):                                           # the ticket cannot be reused
            with c.websocket_connect(f"/api/runners/jobs/{jid}/view?ticket={tk}"):
                pass
        assert json.loads(rw.receive_text())["type"] == "live-stop"                        # closing the viewer stops the laptop session


def test_revoke_disconnects_and_blocks(c):
    r = paired(c)
    with c.websocket_connect("/api/runners/connect", headers={"Authorization": "Bearer " + r["token"]}) as rw:
        assert c.delete(f"/api/runners/{r['runnerId']}", headers={"X-User": "bob@ytl.com"}).status_code == 404
        assert c.delete(f"/api/runners/{r['runnerId']}", headers=U).status_code == 200
        assert json.loads(rw.receive_text())["type"] == "revoked"
    with pytest.raises(WebSocketDisconnect):
        with c.websocket_connect("/api/runners/connect", headers={"Authorization": "Bearer " + r["token"]}) as w:
            w.send_text(json.dumps({"type": "auth", "token": r["token"]}))
            w.receive_text()
