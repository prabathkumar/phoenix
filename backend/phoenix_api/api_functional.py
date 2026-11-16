"""Functional API tests run BY the platform (the agent), not by the repo's CI: cases are built from the API layer (api_layer.py) and fired at a base URL.
Checks per call: status (2xx for valid data, 4xx and never 5xx for invalid data, 404 for a missing item) and the shape of the data given back.
Writes (POST/PUT/PATCH/DELETE with valid data) run only when allow_writes is true; invalid-data cases always run, because a good API rejects them and writes nothing."""
import json
import re
import time

WRITE = ("POST", "PUT", "PATCH", "DELETE")
TYPES = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "array": list, "object": dict}


def _fill(path, vals):
    return re.sub(r"\{(\w+)\}", lambda m: str(vals.get(m.group(1), 1)), path)


def build_cases(endpoints, requirement_key="", max_cases=200):
    cases = []
    for e in endpoints:
        td, m = e.get("testData") or {}, e["method"]
        ok_path = {p: (next((c["value"][p] for c in td.get("path", []) if p in c["value"] and c["name"].endswith("exists")), 1)) for p in e.get("pathParams") or []}
        tag = f"{requirement_key} " if requirement_key else ""
        req = td.get("request") or {}
        ok_status = [200, 201, 202, 204]
        if m not in WRITE or req.get("valid") is not None:
            cases.append({"name": f"{tag}{m} {e['path']} with valid data", "method": m, "path": _fill(e["path"], ok_path), "body": req.get("valid") if m in WRITE else None, "expect": {"status": ok_status, "shape": (e.get("responses") or {}).get("200") or (e.get("responses") or {}).get("201")}, "writes": m in WRITE, "call": f"{m} {e['path']}"})
        for c in req.get("invalid", [])[:8]:
            cases.append({"name": f"{tag}{m} {e['path']}: {c['name']}", "method": m, "path": _fill(e["path"], ok_path), "body": c["value"], "expect": {"status": "4xx"}, "writes": False, "call": f"{m} {e['path']}"})
        for c in req.get("boundary", [])[:4]:
            cases.append({"name": f"{tag}{m} {e['path']}: {c['name']}", "method": m, "path": _fill(e["path"], ok_path), "body": c["value"], "expect": {"status": ok_status}, "writes": True, "call": f"{m} {e['path']}"})
        for c in td.get("path", []):
            if c["expect"] == "2xx":
                continue
            cases.append({"name": f"{tag}{m} {e['path']}: {c['name']}", "method": m, "path": _fill(e["path"], c["value"]), "body": req.get("valid") if m in WRITE else None, "expect": {"status": 404 if c["expect"] == "404" else "4xx"}, "writes": False, "call": f"{m} {e['path']}"})
    return cases[:max_cases]


def check_shape(schema, data, path="$"):
    """Problems found comparing a response body with its schema (missing required fields, wrong types). [] when it fits or there is no schema."""
    if not isinstance(schema, dict):
        return []
    t, bad = schema.get("type"), []
    if t in TYPES and data is not None:
        py = TYPES[t]
        if not isinstance(data, py) or (t in ("integer", "number") and isinstance(data, bool)):
            return [f"{path} should be {t}"]
    if t == "object" and isinstance(data, dict):
        for k in schema.get("required") or []:
            if k not in data:
                bad.append(f"{path}.{k} is missing")
        for k, s in (schema.get("properties") or {}).items():
            if k in data:
                bad += check_shape(s, data[k], f"{path}.{k}")
    if t == "array" and isinstance(data, list) and data:
        bad += check_shape(schema.get("items"), data[0], path + "[0]")
    return bad[:5]


def _status_ok(expect, status):
    if isinstance(expect, list):
        return status in expect
    if isinstance(expect, int):
        return status == expect
    return 400 <= status < 500 if expect == "4xx" else False


async def run_cases(base, cases, fetch, allow_writes=False, token="", pause=None):
    """Fire each case at base. Returns [{name, call, status, ok, ms, detail}] ; a case that would write is 'skipped' unless allow_writes."""
    out, base = [], str(base).rstrip("/")
    for c in cases:
        if c["writes"] and c["method"] in WRITE and not allow_writes:
            out.append({"name": c["name"], "call": c["call"], "status": None, "result": "skipped", "ms": 0, "detail": "writes are off (allowWrites=false)"})
            continue
        h = {"Accept": "application/json", **({"Content-Type": "application/json"} if c["body"] is not None else {}), **({"Authorization": f"Bearer {token}"} if token else {})}
        t0 = time.time()
        try:
            status, text = await fetch(c["method"], base + c["path"], h, json.dumps(c["body"]) if c["body"] is not None else None)
        except Exception as e:
            out.append({"name": c["name"], "call": c["call"], "status": None, "result": "failed", "ms": int((time.time() - t0) * 1000), "detail": f"call failed: {str(e)[:120]}"})
            continue
        ms, why = int((time.time() - t0) * 1000), []
        if status >= 500:
            why.append(f"server error {status}")
        elif not _status_ok(c["expect"]["status"], status):
            why.append(f"status {status}, expected {c['expect']['status']}")
        elif c["expect"].get("shape") and 200 <= status < 300 and status != 204:
            try:
                why += check_shape(c["expect"]["shape"], json.loads(text))
            except Exception:
                why.append("the answer is not JSON")
        out.append({"name": c["name"], "call": c["call"], "status": status, "result": "failed" if why else "passed", "ms": ms, "detail": "; ".join(why) or "ok"})
    return out


def summary(results):
    p, f, s = (sum(1 for r in results if r["result"] == k) for k in ("passed", "failed", "skipped"))
    return {"total": len(results), "passed": p, "failed": f, "skipped": s, "passRate": round(p / (p + f), 3) if p + f else None}
