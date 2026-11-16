"""The API layer of a repo: which calls it offers, what data each call takes and gives, and test data built from that.
Endpoints come from the code (Express/Fastify, FastAPI/Flask, Spring, Laravel, Go routers, ASP.NET) or from an OpenAPI file when the repo has one.
Test data is made WITHOUT the AI, from the schema (valid, boundary, invalid), so the same API always gets the same data and the model cannot invent fields."""
import json
import posixpath
import re

METHODS = ("get", "post", "put", "patch", "delete")
SPEC_NAME = re.compile(r"(^|/)(openapi|swagger)[\w.-]*\.(json|ya?ml)$", re.I)


def _norm(path):
    p = re.sub(r":(\w+)", r"{\1}", str(path or ""))
    p = "/" + p.strip("/") if p.strip("/") else "/"
    return re.sub(r"/+", "/", p)


def _line(code, pos):
    return code.count("\n", 0, pos) + 1


def _ep(method, path, file, code, pos, handler=""):
    p = _norm(path)
    return {"method": method.upper(), "path": p, "file": file, "line": _line(code, pos), "pathParams": re.findall(r"\{(\w+)\}", p), "source": "code",
            "snippet": "\n".join(code[pos:].splitlines()[:25])[:1800]}


def detect_endpoints(file, code, lang):
    """Routes written in one source file. Never raises; returns [] for a file with none."""
    out = []
    try:
        if lang in ("javascript", "typescript"):
            for m in re.finditer(r"\b(?:app|router|server|fastify|api|route)\.(get|post|put|patch|delete)\(\s*['\"`]([^'\"`]+)['\"`]", code):
                out.append(_ep(m.group(1), m.group(2), file, code, m.start()))
        elif lang == "python":
            for m in re.finditer(r"@\w+\.(get|post|put|patch|delete)\(\s*['\"]([^'\"]+)['\"]", code):
                out.append(_ep(m.group(1), m.group(2), file, code, m.start()))
            for m in re.finditer(r"@\w+\.route\(\s*['\"]([^'\"]+)['\"](?:[^)]*?methods\s*=\s*\[([^\]]*)\])?", code):
                for v in re.findall(r"['\"](\w+)['\"]", m.group(2) or "'GET'"):
                    if v.lower() in METHODS:
                        out.append(_ep(v, m.group(1), file, code, m.start()))
        elif lang == "java":
            base = (re.search(r"@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?\"([^\"]*)\"", code) or [None, ""])[1]
            for m in re.finditer(r"@(Get|Post|Put|Patch|Delete)Mapping(?:\(\s*(?:value\s*=\s*|path\s*=\s*)?\"([^\"]*)\")?", code):
                out.append(_ep(m.group(1), base + "/" + (m.group(2) or ""), file, code, m.start()))
        elif lang == "php":
            for m in re.finditer(r"Route::(get|post|put|patch|delete)\(\s*['\"]([^'\"]+)['\"]", code):
                out.append(_ep(m.group(1), m.group(2), file, code, m.start()))
        elif lang == "go":
            for m in re.finditer(r"\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\(\s*\"([^\"]+)\"", code):
                out.append(_ep(m.group(1), m.group(2), file, code, m.start()))
            for m in re.finditer(r"HandleFunc\(\s*\"(?:(GET|POST|PUT|PATCH|DELETE)\s+)?([^\"]+)\"", code):
                out.append(_ep(m.group(1) or "GET", m.group(2), file, code, m.start()))
        elif lang == "csharp":
            base = (re.search(r"\[Route\(\"([^\"]*)\"\)\]", code) or [None, ""])[1].replace("[controller]", posixpath.basename(file).replace("Controller.cs", "").replace(".cs", "").lower())
            for m in re.finditer(r"\[Http(Get|Post|Put|Patch|Delete)(?:\(\s*\"([^\"]*)\"\s*\))?\]", code):
                out.append(_ep(m.group(1), base + "/" + (m.group(2) or ""), file, code, m.start()))
    except Exception:
        return []
    seen, uniq = set(), []
    for e in out:
        k = (e["method"], e["path"])
        if k not in seen:
            seen.add(k)
            uniq.append(e)
    return uniq


# ---- OpenAPI
def _load_spec(text):
    try:
        return json.loads(text)
    except Exception:
        pass
    try:
        import yaml
        d = yaml.safe_load(text)
        return d if isinstance(d, dict) else None
    except Exception:
        return None


def _resolve(spec, node, depth=0):
    if depth > 8 or not isinstance(node, dict):
        return node if isinstance(node, dict) else {}
    ref = node.get("$ref")
    if isinstance(ref, str) and ref.startswith("#/"):
        cur = spec
        for part in ref[2:].split("/"):
            cur = cur.get(part.replace("~1", "/").replace("~0", "~")) if isinstance(cur, dict) else None
        return _resolve(spec, cur or {}, depth + 1)
    return node


def from_openapi(text, file="openapi"):
    spec = _load_spec(text)
    if not isinstance(spec, dict) or not isinstance(spec.get("paths"), dict):
        return []
    out = []
    for path, item in spec["paths"].items():
        if not isinstance(item, dict):
            continue
        for m, op in item.items():
            if m.lower() not in METHODS or not isinstance(op, dict):
                continue
            params = [_resolve(spec, p) for p in (item.get("parameters") or []) + (op.get("parameters") or [])]
            body = ((_resolve(spec, op.get("requestBody") or {}).get("content") or {}).get("application/json") or {}).get("schema")
            responses = {}
            for code, r in (op.get("responses") or {}).items():
                sch = (((_resolve(spec, r) or {}).get("content") or {}).get("application/json") or {}).get("schema")
                responses[str(code)] = _resolve(spec, sch) if sch else None
            out.append({"method": m.upper(), "path": _norm(path), "file": file, "line": 0, "source": "openapi", "summary": str(op.get("summary") or "")[:160],
                        "pathParams": [p.get("name") for p in params if p.get("in") == "path"], "query": [{"name": p.get("name"), "required": bool(p.get("required")), "schema": _resolve(spec, p.get("schema") or {})} for p in params if p.get("in") == "query"],
                        "requestSchema": _deref(spec, body), "responses": {k: _deref(spec, v) for k, v in responses.items()}})
    return out


def _deref(spec, node, depth=0):
    node = _resolve(spec, node) if node else None
    if not isinstance(node, dict) or depth > 6:
        return node
    n = dict(node)
    if isinstance(n.get("properties"), dict):
        n["properties"] = {k: _deref(spec, v, depth + 1) for k, v in n["properties"].items()}
    if isinstance(n.get("items"), dict):
        n["items"] = _deref(spec, n["items"], depth + 1)
    return n


# ---- test data, from the schema
def _valid(s, name="value", depth=0):
    if not isinstance(s, dict) or depth > 6:
        return "sample"
    if "example" in s:
        return s["example"]
    if s.get("enum"):
        return s["enum"][0]
    t = s.get("type") or ("object" if "properties" in s else "string")
    if t == "object":
        req = s.get("required") or list((s.get("properties") or {}))
        return {k: _valid(v, k, depth + 1) for k, v in (s.get("properties") or {}).items() if k in req}
    if t == "array":
        return [_valid(s.get("items") or {}, name, depth + 1)]
    if t == "integer":
        return int(max(s.get("minimum", 1), 1)) if s.get("minimum", 1) <= s.get("maximum", 10**9) else int(s.get("minimum", 1))
    if t == "number":
        return float(s.get("minimum", 1.5))
    if t == "boolean":
        return True
    f = s.get("format", "")
    if f == "email":
        return "test.user@example.com"
    if f == "uuid":
        return "123e4567-e89b-42d3-a456-426614174000"
    if f == "date-time":
        return "2026-01-15T10:30:00Z"
    if f == "date":
        return "2026-01-15"
    if f in ("uri", "url"):
        return "https://example.com/test"
    v = f"test-{name}"
    if s.get("minLength"):
        v = (v * (s["minLength"] // max(len(v), 1) + 1))[: max(s["minLength"], 1)]
    if s.get("maxLength"):
        v = v[: s["maxLength"]]
    return v


def _bad_value(s):
    t = (s or {}).get("type", "string")
    return "not-a-number" if t in ("integer", "number") else "text" if t == "boolean" else 12345 if t == "string" else "wrong"


def sample_data(schema):
    """{valid, boundary: [{name, value}], invalid: [{name, value, why}]} for a JSON schema. Deterministic."""
    if not isinstance(schema, dict):
        return {"valid": None, "boundary": [], "invalid": []}
    valid = _valid(schema)
    boundary, invalid = [], []
    if schema.get("type") == "object" or "properties" in schema:
        props = schema.get("properties") or {}
        for k, s in props.items():
            if not isinstance(s, dict):
                continue
            def with_(v, k=k):
                d = dict(valid) if isinstance(valid, dict) else {}
                d[k] = v
                return d
            if "minimum" in s:
                boundary.append({"name": f"{k} at minimum", "value": with_(s["minimum"])})
                invalid.append({"name": f"{k} below minimum", "value": with_(s["minimum"] - 1), "why": f"{k} must be at least {s['minimum']}"})
            if "maximum" in s:
                boundary.append({"name": f"{k} at maximum", "value": with_(s["maximum"])})
                invalid.append({"name": f"{k} above maximum", "value": with_(s["maximum"] + 1), "why": f"{k} must be at most {s['maximum']}"})
            if s.get("maxLength"):
                boundary.append({"name": f"{k} at max length", "value": with_("a" * s["maxLength"])})
                invalid.append({"name": f"{k} over max length", "value": with_("a" * (s["maxLength"] + 1)), "why": f"{k} is longer than {s['maxLength']}"})
            if s.get("minLength"):
                invalid.append({"name": f"{k} under min length", "value": with_("a" * (s["minLength"] - 1)), "why": f"{k} is shorter than {s['minLength']}"})
            if s.get("enum"):
                invalid.append({"name": f"{k} not in the allowed list", "value": with_("__not_allowed__"), "why": f"{k} must be one of {s['enum']}"})
            invalid.append({"name": f"{k} has the wrong type", "value": with_(_bad_value(s)), "why": f"{k} must be {s.get('type', 'a valid value')}"})
        for k in schema.get("required") or []:
            if isinstance(valid, dict) and k in valid:
                d = {a: b for a, b in valid.items() if a != k}
                invalid.append({"name": f"{k} is missing", "value": d, "why": f"{k} is required"})
        invalid.append({"name": "empty body", "value": {}, "why": "required fields are missing"} if schema.get("required") else {"name": "body is not an object", "value": [], "why": "the body must be an object"})
    return {"valid": valid, "boundary": boundary[:12], "invalid": invalid[:14]}


def path_data(endpoint):
    """Cases for the path and query parts of a call, from the names alone when there is no schema."""
    cases = []
    for p in endpoint.get("pathParams") or []:
        idlike = p.lower().endswith("id") or p.lower() == "id"
        cases += [{"name": f"{p} exists", "value": {p: 1 if idlike else "sample"}, "expect": "2xx"}, {"name": f"{p} not found", "value": {p: 999999999 if idlike else "does-not-exist"}, "expect": "404"},
                  {"name": f"{p} is not valid", "value": {p: "abc'--" if idlike else ""}, "expect": "4xx, never 5xx"}]
    return cases


def enrich(endpoint):
    e = dict(endpoint)
    e["testData"] = {"request": sample_data(e.get("requestSchema")) if e.get("requestSchema") else None, "path": path_data(e),
                     "responses": {k: sample_data(v)["valid"] for k, v in (e.get("responses") or {}).items() if v}}
    return e


def analyse(files, read_file_sync_texts, language_of):
    """files: [path]; read_file_sync_texts: {path: text} already read. Returns the API layer: endpoints (spec first, then code), spec files found."""
    spec_files = [f for f in files if SPEC_NAME.search(f)]
    eps = []
    for f in spec_files:
        if f in read_file_sync_texts:
            eps += from_openapi(read_file_sync_texts[f], f)
    have = {(e["method"], e["path"]) for e in eps}
    for f, text in read_file_sync_texts.items():
        lang = language_of(f)
        if not lang or f in spec_files:
            continue
        for e in detect_endpoints(f, text, lang):
            if (e["method"], e["path"]) not in have:
                have.add((e["method"], e["path"]))
                eps.append(e)
    return {"endpoints": [enrich(e) for e in eps], "specFiles": spec_files}
