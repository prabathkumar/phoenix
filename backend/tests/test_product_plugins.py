import json
import asyncio
import pytest
from fastapi.testclient import TestClient
from phoenix_api import product_plugins as P
from phoenix_api.app import create_app
from phoenix_api.service import Deps


def run(c):
    return asyncio.run(c)


class Fake:
    """A pretend product: sign-in, records, and refusing unauthenticated calls."""
    def __init__(self, token="T", leak=False, open_=False):
        self.calls, self.db, self.token, self.leak, self.open = [], {}, token, leak, open_

    async def __call__(self, method, url, headers=None, body=None):
        headers = headers or {}
        self.calls.append((method, url, headers, body))
        if "oauth2" in url or "access_token" in url or url.endswith("/Session"):
            return 200, json.dumps({"access_token": self.token, "SessionID": "S1"})
        authed = headers.get("Authorization") == f"Bearer {self.token}" or "SessionID=S1" in url or "Basic" in headers.get("Authorization", "")
        if self.open and method == "GET":
            return 200, "{}"
        if not authed and not self.open:
            return 401, "Traceback (most recent call last): boom" if self.leak else '{"error":"unauthorised"}'
        if method == "POST":
            b = json.loads(body)
            if not b or (isinstance(b.get("Name", "x"), str) and b.get("Name", "x") == ""):
                return 400, "{}"
            rid = str(len(self.db) + 1)
            self.db[rid] = body
            return 201, json.dumps({"id": rid, "accountid": rid, "TicketID": rid, "data": {"id": rid}})
        if method == "DELETE":
            return 204, ""
        rid = url.split("?")[0].rstrip("/").split("/")[-1].strip("()'")
        return (200, self.db[rid]) if rid in self.db else (404, "{}")


SF = {"SALESFORCE_BASE_URL": "https://acme.my.salesforce.com", "SALESFORCE_CLIENT_ID": "a", "SALESFORCE_CLIENT_SECRET": "b"}


def test_every_product_has_a_plan_with_no_credentials():
    for k in P.PLUGINS:
        pl = P.plan(k, {})
        assert pl["cases"] and pl["scenarios"]
    assert all(c["method"] == "GET" for c in P.plan("sap")["cases"])      # SAP is read-only here


def test_catalog_says_what_is_missing():
    c = {x["id"]: x for x in P.catalog({"SAP_BASE_URL": "https://s.example.com"})}
    assert c["sap"]["ready"] is True and c["salesforce"]["ready"] is False and "SALESFORCE_CLIENT_ID" in c["salesforce"]["missing"]


def test_unset_or_http_or_bad_sign_in_is_unavailable_never_a_pass():
    assert run(P.run("salesforce", {}, Fake())).get("unavailable")
    assert "https" in run(P.run("salesforce", {**SF, "SALESFORCE_BASE_URL": "http://acme.example.com"}, Fake()))["detail"]
    assert "user name" in run(P.run("salesforce", {**SF, "SALESFORCE_BASE_URL": "https://u:p@acme.example.com"}, Fake()))["detail"]
    bad = lambda *a, **k: asyncio.sleep(0, (401, "no"))
    assert run(P.run("salesforce", SF, bad)).get("unavailable")
    assert "sign-in host" in run(P.run("salesforce", {**SF, "SALESFORCE_TOKEN_URL": "https://evil.example.com/t"}, Fake()))["detail"]


def test_functional_skips_writes_unless_allowed_and_uses_the_token():
    f = Fake()
    r = run(P.run("salesforce", SF, f, "functional", allow_writes=False))
    assert r["data"]["summary"]["skipped"] > 0 and not any(c[0] == "POST" and c[3] and "<script>" in c[3] for c in f.calls)
    assert all(c[2].get("Authorization") == "Bearer T" for c in f.calls if "oauth2" not in c[1])
    f2 = Fake()
    run(P.run("salesforce", SF, f2, "functional", allow_writes=True))
    assert any(c[0] == "POST" and "sobjects" in c[1] for c in f2.calls)


def test_sap_never_writes_even_if_asked():
    f = Fake(token="T")
    r = run(P.run("sap", {"SAP_BASE_URL": "https://s.example.com", "SAP_TOKEN": "T"}, f, "functional", allow_writes=True))
    assert not any(c[0] in ("POST", "PUT", "PATCH", "DELETE") for c in f.calls) and "read-only" in r["detail"]


def test_ticketing_signs_in_by_session_and_puts_no_password_in_a_url():
    f = Fake()
    env = {"OTOBO_BASE_URL": "https://help.example.com", "OTOBO_USER": "svc", "OTOBO_PASSWORD": "pw-secret"}
    run(P.run("otobo", env, f, "functional"))
    assert any("SessionID=S1" in c[1] for c in f.calls) and not any("pw-secret" in c[1] for c in f.calls)


def test_readback_creates_reads_matches_and_removes():
    f = Fake()
    assert run(P.run("salesforce", SF, f, "readback", allow_writes=False))["data"]["skipped"]
    r = run(P.run("salesforce", SF, f, "readback", allow_writes=True))
    assert r["ok"] and "removed" in r["detail"] and r["data"]["tag"].startswith("PHOENIX-TEST")
    assert any(c[0] == "DELETE" for c in f.calls)


def test_security_flags_open_access_and_leaky_errors():
    assert run(P.run("salesforce", SF, Fake(), "security"))["ok"]
    assert not run(P.run("salesforce", SF, Fake(open_=True), "security"))["ok"]
    r = run(P.run("salesforce", SF, Fake(leak=True), "security"))
    assert not r["ok"] and any("leaks" in c["detail"] for c in r["data"]["checks"])


def test_perf_plan_reads_only_and_keeps_the_token_out_of_the_file():
    r = run(P.run("dynamics365", {"D365_BASE_URL": "https://org.crm.dynamics.com/api/data/v9.2", "D365_TENANT_ID": "t", "D365_CLIENT_ID": "c", "D365_CLIENT_SECRET": "s"}, Fake(), "perf"))
    lf = r["data"]["locustfile"]
    assert "PRODUCT_TOKEN" in lf and "client.post" not in lf and compile(lf, "x", "exec")


def test_api_endpoints(tmp_path):
    d = Deps(env={**SF, "PHOENIX_DATA_DIR": str(tmp_path)})
    d.plugin_fetch = Fake()
    c = TestClient(create_app(d))
    assert {p["id"] for p in c.get("/api/plugins").json()["plugins"]} == set(P.PLUGINS)
    assert c.post("/api/plugins/salesforce/run", json={"mode": "plan"}).status_code == 401
    assert c.post("/api/plugins/nope/run", json={}, headers={"X-User": "a@b.c"}).status_code == 404
    r = c.post("/api/plugins/salesforce/run", json={"mode": "security"}, headers={"X-User": "a@b.c"}).json()
    assert r["ok"] is True


def test_compat_says_when_the_plugin_must_be_upgraded_with_the_product():
    p = P.PLUGINS["odoo"]
    assert [P.compat(p, v) for v in ("19.0", "19.0+e", "18.0", "20.0", None)] == ["ok", "ok", "older", "newer", "unknown"]


def test_run_reports_product_and_plugin_versions_and_flags_a_newer_product():
    env = {"ODOO_BASE_URL": "https://erp.example.com", "ODOO_API_KEY": "K", "ODOO_DB": "d"}

    def fake(ver):
        async def f(method, url, headers=None, body=None):
            if url.endswith("/web/webclient/version_info"):
                return 200, json.dumps({"result": {"server_version": ver}})
            return (200, "[]") if (headers or {}).get("Authorization") == "bearer K" else (401, "{}")
        return f
    ok = run(P.run("odoo", env, fake("19.0"), "security"))
    assert ok["product"] == {"version": "19.0", "plugin": "0.1.0", "supports": ["19.0", "19.0"], "compat": "ok"} and not ok.get("stale")
    new = run(P.run("odoo", env, fake("20.0"), "security"))
    assert new["stale"] and "Upgrade the Odoo" in new["detail"]
    old = run(P.run("odoo", env, fake("17.0"), "functional"))
    assert old["stale"] and "plugin release for that version" in old["detail"]
    assert all(c["method"] == "POST" for c in P.plan("odoo")["cases"])
