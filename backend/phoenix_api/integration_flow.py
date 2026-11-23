"""Integration flow (pure, no DB): find a repo's inbound and outbound HTTP calls, read its OpenAPI file,
build mock responses for the outbound calls, and write one case per requirement with inputs and expected outputs.

discover(root)                      -> {inbound:[{method,path,file,line}], outbound:[{method,url,file,line}], openapi:{...}|None}
mock_for(call, openapi)             -> {status, body} a stand-in answer for an outbound call
build_cases(disc, requirements, call_json=None) -> [{requirement, method, path, input, expected, mocks:[...], source}]
"""
import json

from .sync_ask import ask
import os
import re

SKIP_DIRS = {".git", "node_modules", "venv", ".venv", "__pycache__", "dist", "build", "target", "vendor", "tests", "test", "docs"}
EXTS = {".py", ".js", ".ts", ".java", ".go", ".php", ".rb", ".kt", ".cs"}
VERBS = "get|post|put|patch|delete"

INBOUND = [
    re.compile(r"@(?:\w+\.)?(?P<m>%s)\(\s*[\"'](?P<p>/[^\"']*)" % VERBS, re.I),                       # FastAPI, Nest, Flask 2
    re.compile(r"@\w+\.route\(\s*[\"'](?P<p>/[^\"']*)[\"'](?:.*methods=\[[\"'](?P<m>\w+))?", re.I),  # Flask
    re.compile(r"\b(?:app|router|api)\.(?P<m>%s)\(\s*[\"'`](?P<p>/[^\"'`]*)" % VERBS, re.I),          # Express
    re.compile(r"@(?P<m>Get|Post|Put|Patch|Delete)Mapping\(\s*(?:value\s*=\s*)?\"(?P<p>/[^\"]*)", re.I),  # Spring
    re.compile(r"\bRoute::(?P<m>%s)\(\s*['\"](?P<p>/[^'\"]*)" % VERBS, re.I),                         # Laravel
    re.compile(r"\bHandleFunc\(\s*\"(?P<p>/[^\"]*)\"()"),                                             # Go net/http
]
OUTBOUND = [
    re.compile(r"\b(?:requests|httpx|session|client)\.(?P<m>%s)\(\s*f?[\"'](?P<u>https?://[^\"']+)" % VERBS, re.I),
    re.compile(r"\b(?:axios|got|ky|http|https)\.(?P<m>%s)\(\s*[\"'`](?P<u>https?://[^\"'`]+)" % VERBS, re.I),
    re.compile(r"\bfetch\(\s*[\"'`](?P<u>https?://[^\"'`]+)()"),
    re.compile(r"\bhttp\.(?P<m>Get|Post)\(\s*\"(?P<u>https?://[^\"]+)", re.I),                         # Go
    re.compile(r"\b(?:RestTemplate|restTemplate|webClient)\.\w*\(\s*\"(?P<u>https?://[^\"]+)\"()"),
]
OPENAPI_NAMES = ("openapi.json", "openapi.yaml", "openapi.yml", "swagger.json", "swagger.yaml", "swagger.yml")


def _files(root):
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in SKIP_DIRS and not d.startswith(".")]
        for f in fns:
            yield os.path.join(dp, f)


def _read(p):
    try:
        with open(p, encoding="utf-8", errors="replace") as fh:
            return fh.read(400_000)
    except OSError:
        return ""


def load_openapi(root):
    for p in _files(root):
        if os.path.basename(p).lower() in OPENAPI_NAMES:
            text = _read(p)
            try:
                if p.endswith(".json"):
                    return json.loads(text)
                import yaml  # optional
                return yaml.safe_load(text)
            except Exception:
                return None
    return None


def _openapi_routes(spec):
    out = []
    for path, ops in ((spec or {}).get("paths") or {}).items():
        for m, op in (ops or {}).items():
            if m.lower() in VERBS.split("|") and isinstance(op, dict):
                out.append({"method": m.upper(), "path": path, "file": "openapi", "line": 0, "summary": op.get("summary", "")})
    return out


def discover(root):
    inbound, outbound = [], []
    for p in _files(root):
        if os.path.splitext(p)[1] not in EXTS:
            continue
        rel = os.path.relpath(p, root)
        for n, line in enumerate(_read(p).splitlines(), 1):
            for rx in INBOUND:
                m = rx.search(line)
                if m:
                    inbound.append({"method": ((m.groupdict().get("m")) or "GET").upper(), "path": m.group("p"), "file": rel, "line": n}); break
            for rx in OUTBOUND:
                m = rx.search(line)
                if m:
                    outbound.append({"method": ((m.groupdict().get("m")) or "GET").upper(), "url": m.group("u"), "file": rel, "line": n}); break
    spec = load_openapi(root)
    seen = {(i["method"], i["path"]) for i in inbound}
    for r in _openapi_routes(spec):
        if (r["method"], r["path"]) not in seen:
            inbound.append(r)
    return {"inbound": inbound, "outbound": outbound, "openapi": bool(spec), "spec": spec}


def mock_for(call, spec=None):
    """A stand-in answer for an outbound call. Uses the OpenAPI example when the call matches a path, else a plain 200."""
    path = re.sub(r"^https?://[^/]+", "", call.get("url", ""))
    for p, ops in ((spec or {}).get("paths") or {}).items():
        if p == path:
            op = (ops or {}).get(call.get("method", "get").lower()) or {}
            for code, resp in (op.get("responses") or {}).items():
                ex = (((resp or {}).get("content") or {}).get("application/json") or {}).get("example")
                if ex is not None:
                    return {"status": int(code) if str(code).isdigit() else 200, "body": ex}
    return {"status": 200, "body": {"ok": True}}


PROMPT = ("You write API integration cases. For each requirement pick the best matching route and give a request body "
          "(input) and the expected response (status and fields) that proves the requirement. "
          'Reply as JSON: {"cases":[{"requirement":"","method":"","path":"","input":{},"expected":{"status":200,"body_has":{}}}]}')


def build_cases(disc, requirements, call_json=None):
    """One case per requirement. With a model, it picks route, input and expected output; without one, a rule-based draft
    that is clearly marked so a person fills the values."""
    inbound = disc.get("inbound", [])
    mocks = [{"method": o["method"], "url": o["url"], **mock_for(o, disc.get("spec"))} for o in disc.get("outbound", [])]
    cases = []
    if call_json and inbound:
        try:
            out = ask(call_json, PROMPT, json.dumps({"requirements": requirements, "routes": inbound[:60]})[:12000])
            for c in (out or {}).get("cases", []):
                if c.get("path") and c.get("requirement"):
                    cases.append({**c, "mocks": mocks, "source": "model"})
        except Exception:
            cases = []
    done = {c["requirement"] for c in cases}
    for r in requirements:
        key = r.get("key") if isinstance(r, dict) else str(r)
        if key in done:
            continue
        words = set(re.findall(r"[a-z]{4,}", (r.get("title", "") + " " + r.get("description", "")).lower())) if isinstance(r, dict) else set()
        best = max(inbound, key=lambda i: len(words & set(re.findall(r"[a-z]{4,}", i["path"].lower()))), default=None)
        cases.append({"requirement": key, "method": (best or {}).get("method", ""), "path": (best or {}).get("path", ""), "input": {},
                      "expected": {"status": 200, "body_has": {}}, "mocks": mocks,
                      "source": "draft: route guessed from words, a person must fill input and expected" if best else "no route found for this requirement"})
    return cases


def to_pytest(cases, base_url_env="TARGET_BASE_URL"):
    """Runnable pytest file: starts no server, calls the system under test at $TARGET_BASE_URL, skips cases with no route."""
    lines = ["import json, os, pytest, requests", f'BASE = os.environ.get("{base_url_env}", "")', "", "CASES = json.loads(" + repr(json.dumps(cases)) + ")", "", "@pytest.mark.integration", '@pytest.mark.parametrize("c", CASES, ids=[c["requirement"] for c in CASES])',
        "def test_case(c):", "    if not BASE or not c['path']:", "        pytest.skip('no base url or route')",
        "    r = requests.request(c['method'], BASE + c['path'], json=c['input'] or None, timeout=20)",
        "    assert r.status_code == c['expected'].get('status', 200)",
        "    body = r.json() if r.headers.get('content-type', '').startswith('application/json') else {}",
        "    for k, v in (c['expected'].get('body_has') or {}).items():", "        assert body.get(k) == v"]
    return "\n".join(lines) + "\n"
