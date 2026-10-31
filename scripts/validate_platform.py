#!/usr/bin/env python3
"""Checks the running Phoenix platform, component by component.   python3 scripts/validate_platform.py http://localhost:8000
Each line is PASS, FAIL, NOT SET UP (a tool, key or service is missing: not a bug) or NEEDS YOU. Exit code 1 only when something FAILS.
It creates a few clearly named test records (validate-*) in the platform's own database; it never touches your app under test."""
import json
import sys
import time
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000").rstrip("/")
rows, failed = [], 0


def call(method, path, body=None, user="validate-a", timeout=600):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(), headers={"Content-Type": "application/json", "X-User": user})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"detail": str(e)}


def report(status, name, detail=""):
    global failed
    failed += status == "FAIL"
    rows.append((status, name, detail))
    print(f"{status:<11} {name}" + (f"  -  {detail}" if detail else ""), flush=True)


def check(name, fn):
    try:
        r = fn()
        report(*(r if isinstance(r, tuple) else ("PASS", r or "")) if False else ((r[0], name, r[1]) if isinstance(r, tuple) else ("PASS", name, r or "")))
    except Exception as e:
        report("FAIL", name, f"{type(e).__name__}: {e}")


def health():
    c, h = call("GET", "/api/health")
    assert c == 200 and h.get("ok"), f"API did not answer ({c}) {h}"
    return "PASS", "API is up"


def postgres():
    _, h = call("GET", "/api/health")
    return ("PASS", "PostgreSQL") if h["postgres"] == "postgresql" else ("NOT SET UP", f"using {h['postgres']} (set DATABASE_URL to PostgreSQL)")


def clickhouse():
    _, h = call("GET", "/api/health")
    a = h["analytics"]
    return ("PASS", "ClickHouse") if a["backend"] == "clickhouse" else ("NOT SET UP", a.get("note") or "memory only")


def tools():
    c, t = call("GET", "/api/pipeline/tools")
    assert c == 200
    for k, v in t["tools"].items():
        if k.endswith("Why"):
            continue
        why = t["tools"].get(k + "Why")
        report("PASS" if v else "NOT SET UP", f"tool: {k}", why or (str(v) if v not in (True, False) else ""))
    return None


def gateway():
    c, r = call("POST", "/api/gateway/import")
    assert c == 200, r
    c, p = call("GET", "/api/gateway/prompts")
    assert c == 200 and len(p["prompts"]) > 0, "no prompts in the library after import"
    return "PASS", f"{len(p['prompts'])} prompts stored and versioned"


def guardrails():
    c, g = call("GET", "/api/gateway/guardrails")
    assert c == 200 and {r["type"] for r in g["rules"]} >= {"secrets", "pii"}
    return "PASS", f"{len(g['rules'])} rules"


def signoff_flow():
    cid = f"validate-{int(time.time())}"
    assert call("POST", "/api/cases", {"id": cid, "title": "validate: sign-off flow", "steps": ["a"], "requirement": "validate"})[0] == 200
    c, so = call("POST", f"/api/signoff/case/{cid}/request", {}, "validate-a")
    assert c == 200, so
    c, r = call("POST", f"/api/signoff/{so['id']}/decide", {"decision": "approved"}, "validate-a")
    assert c == 400 and "cannot approve" in json.dumps(r), f"requester could approve their own sign-off ({c})"
    c, r = call("POST", f"/api/signoff/{so['id']}/decide", {"decision": "rejected"}, "validate-b")
    assert c == 400, "a rejection without a reason was accepted"
    c, r = call("POST", f"/api/signoff/{so['id']}/decide", {"decision": "approved", "note": "validated"}, "validate-b")
    assert c == 200 and r["status"] == "approved" and [e["action"] for e in r["trail"]] == ["requested", "approved"], r
    return "PASS", "four eyes enforced, reasons required, audit trail kept"


def pipeline_model():
    c, r = call("POST", "/api/pipeline/run", {"goal": "validate", "requirement": "User can log in with email and password.", "requirementKey": "validate", "stages": ["scenarios", "cases"]})
    assert c == 200, r
    st = {s["id"]: s for s in r["stages"]}
    if st["scenarios"]["status"] == "unavailable":
        return "NOT SET UP", st["scenarios"]["detail"]
    assert st["scenarios"]["status"] == "passed", st["scenarios"]
    return "PASS", f"{st['scenarios']['detail']}; cases: {st['cases']['status']} ({st['cases']['detail']}); run {r['runId']}"


def requirement_formats():
    import base64
    c, r = call("POST", "/api/pipeline/run", {"goal": "validate formats", "requirementFile": {"name": "r.md", "base64": base64.b64encode(b"# Req\nUser can pay by card.").decode()}, "stages": ["feedback"]})
    assert c == 200 and r["requirement"]["type"] == "md", r
    c, r = call("POST", "/api/pipeline/run", {"goal": "ssrf", "requirementUrl": "http://169.254.169.254/latest/meta-data/", "stages": ["feedback"]})
    assert c == 400, "a cloud-metadata address was not refused"
    return "PASS", "file upload read; private/metadata address refused"


def gates():
    c, r = call("POST", "/api/pipeline/run", {"goal": "validate gates", "appUrl": "http://example.com", "stages": ["dast", "defects"], "autonomy": "run-everything"})
    st = {s["id"]: s["status"] for s in r["stages"]}
    assert st["dast"] == "needs-you", f"a live scan ran without approval: {st}"
    return "PASS", "live scan waits for approval even at 'run everything'"


def execution():
    c, r = call("POST", "/api/pipeline/run", {"goal": "validate execution", "web": {"url": "http://example.com", "steps": "open the page"}, "stages": ["execution"]})
    s = next(x for x in r["stages"] if x["id"] == "execution")
    if s["status"] == "unavailable":
        return "NOT SET UP", s["detail"]
    return ("PASS", s["detail"]) if s["status"] in ("passed", "failed") else ("FAIL", s["detail"])


def dashboard():
    c, d = call("GET", "/api/dashboard?days=7")
    assert c == 200 and {"execution", "signoff", "ai", "stores"} <= set(d), d
    return "PASS", f"{d['execution']['total']} executions, {sum(d['signoff']['cases'].values())} cases, {d['ai']['calls']['total']} model calls"


for name, fn in [("API", health), ("Database (PostgreSQL)", postgres), ("AI telemetry (ClickHouse)", clickhouse), ("Prompt library", gateway), ("Guardrails", guardrails),
                 ("Sign-off flow", signoff_flow), ("Requirement from file, private link refused", requirement_formats), ("Approval gates", gates),
                 ("Model: scenarios and cases", pipeline_model), ("Execution engine (web/mobile)", execution), ("Monitoring dashboard", dashboard)]:
    check(name, fn)
tools()
n = lambda s: sum(r[0] == s for r in rows)  # noqa: E731
print(f"\n{n('PASS')} passed, {n('FAIL')} failed, {n('NOT SET UP')} not set up")
sys.exit(1 if failed else 0)
