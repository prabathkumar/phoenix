import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from fastapi.testclient import TestClient  # noqa: E402
from phoenix_api import http as _http  # noqa: E402
from phoenix_api.app import create_app  # noqa: E402
from phoenix_api.service import Deps  # noqa: E402


def client(env):
    return TestClient(create_app(Deps(env=env)))


def test_live_start_needs_a_named_person_a_safe_address_and_an_engine(monkeypatch):
    calls = []

    async def fake(method, url, headers=None, body=None, timeout=60):
        calls.append((method, url, body))
        return 200, '{"port": 8092}'
    monkeypatch.setattr(_http, "fetch", fake)
    c = client({"ENGINE_URL": "http://engine:8091"})
    ok = {"url": "https://www.yes.my"}
    assert c.post("/api/live/start", json=ok).status_code == 401                                   # nobody named
    assert c.post("/api/live/start", json={"url": "http://169.254.169.254/"}, headers={"X-User": "p"}).status_code == 400
    assert c.post("/api/live/start", json={"url": "file:///etc/passwd"}, headers={"X-User": "p"}).status_code == 400
    assert c.post("/api/live/start", json={}, headers={"X-User": "p"}).status_code == 400
    assert not calls
    r = c.post("/api/live/start", json={**ok, "runOn": "BrowserStack"}, headers={"X-User": "p"})
    assert r.status_code == 200 and r.json() == {"port": 8092, "runOn": "browserstack"}
    assert calls[0][1] == "http://engine:8091/api/web-sessions" and '"runOn": "browserstack"' in calls[0][2]
    assert client({}).post("/api/live/start", json=ok, headers={"X-User": "p"}).status_code == 503


def test_engine_failure_is_a_clean_502(monkeypatch):
    async def fake(*a, **k):
        return 500, '{"error": "Could not start the browser: nope"}'
    monkeypatch.setattr(_http, "fetch", fake)
    r = client({"ENGINE_URL": "http://e"}).post("/api/live/start", json={"url": "https://x.test"}, headers={"X-User": "p"})
    assert r.status_code == 502 and "nope" in r.json()["detail"]
