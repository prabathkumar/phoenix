"""AI-written unit tests for several languages, wired to the repo and to Semgrep.
Languages: JavaScript, TypeScript, Python, Java, Go, C#, PHP. Semgrep findings steer file choice and go into the prompt.
Checks: not empty, right test shape, real syntax check where a toolchain exists (node, python). The generated tests are NOT run here; the repo's CI runs them on the pull request."""
import ast
import json
import posixpath
import re
import subprocess

LANGS = {
    "javascript": {"ext": (".js", ".mjs", ".cjs"), "framework": "node:test with node:assert", "test": lambda f: re.sub(r"\.(m|c)?js$", ".test.js", f)},
    "typescript": {"ext": (".ts", ".tsx"), "framework": "Vitest (import { describe, it, expect } from 'vitest')", "test": lambda f: re.sub(r"\.tsx?$", ".test.ts", f)},
    "python": {"ext": (".py",), "framework": "pytest", "test": lambda f: posixpath.join(posixpath.dirname(f), "test_" + posixpath.basename(f))},
    "java": {"ext": (".java",), "framework": "JUnit 5 (org.junit.jupiter)", "test": lambda f: re.sub(r"\.java$", "Test.java", re.sub(r"(^|/)src/main/", r"\1src/test/", f))},
    "go": {"ext": (".go",), "framework": "the standard testing package", "test": lambda f: re.sub(r"\.go$", "_test.go", f)},
    "php": {"ext": (".php",), "framework": "PHPUnit (PHPUnit\\Framework\\TestCase)", "test": lambda f: re.sub(r"\.php$", "Test.php", re.sub(r"(^|/)(src|app|lib)/", r"\1tests/", f))},
    "csharp": {"ext": (".cs",), "framework": "xUnit", "test": lambda f: re.sub(r"\.cs$", "Tests.cs", f)},
}
IGNORE = re.compile(r"(^|/)(node_modules|vendor|dist|build|target|bin|obj|\.git|generated)/")
IS_TEST = re.compile(r"(Test\.php$|\.test\.|\.spec\.|_test\.|(^|/)test_|Tests?\.(java|cs)$|(^|/)(tests?|__tests__)/)", re.I)
SHAPE = {"javascript": r"\b(test|it|describe)\s*\(", "typescript": r"\b(test|it|describe)\s*\(", "python": r"\bdef test_", "java": r"@Test\b", "go": r"func Test\w+\(t \*testing\.T\)", "csharp": r"\[(Fact|Theory)\]", "php": r"function test\w+\(|@test\b|#\[Test\]"}


def language_of(f):
    e = posixpath.splitext(f)[1].lower()
    return next((k for k, v in LANGS.items() if e in v["ext"]), None)


def pick_files(all_files, only=None, flagged=(), max=5, languages=None):
    ok = lambda f: language_of(f) and not IS_TEST.search(f) and not IGNORE.search(f) and (not languages or language_of(f) in languages)  # noqa: E731
    pool = [f for f in (only or all_files) if ok(f)]
    return ([f for f in pool if f in flagged] + [f for f in pool if f not in flagged])[:max]


def parse_semgrep(j):
    try:
        j = json.loads(j) if isinstance(j, str) else j
    except Exception:
        return {}
    out = {}
    results = j.get("results") if isinstance(j, dict) else None
    for r in (results if isinstance(results, list) else []):
        if not isinstance(r, dict):
            continue
        f = re.sub(r"^\./", "", str(r.get("path", "")))
        out.setdefault(f, []).append(f"{str(r.get('check_id', '')).split('.')[-1]}: {str((r.get('extra') or {}).get('message', ''))[:200]} (line {(r.get('start') or {}).get('line', '?')})")
    return out


def syntax_check(lang, code, run=subprocess.run):
    try:
        if lang == "python":
            ast.parse(code)
            return {"ok": True}
        if lang == "php":
            r = run(["php", "-l"], input=code, capture_output=True, text=True, timeout=20)
            return {"ok": True} if r.returncode == 0 else {"ok": False, "why": (r.stdout or r.stderr).splitlines()[0] if (r.stdout or r.stderr) else "syntax error"}
        if lang == "javascript":
            r = run(["node", "--check", "--input-type=module", "-"], input=code, capture_output=True, text=True, timeout=20)
            return {"ok": True} if r.returncode == 0 or re.search(r"require is not defined|Cannot use import", r.stderr) else {"ok": False, "why": r.stderr.splitlines()[0] if r.stderr else "syntax error"}
    except SyntaxError as e:
        return {"ok": False, "why": str(e)}
    except Exception:
        pass
    return {"ok": True, "unchecked": True}


def _strip_fence(s):
    return re.sub(r"\n?```\s*$", "", re.sub(r"^\s*```[\w+-]*\n?", "", str(s or "")))


async def generate_tests(files, read_file, call_json, get_prompt, findings=None, syntax=syntax_check, requirement=None, changes=None):
    """requirement = {key, text}: every test is named with the key so the requirement can be followed to the code that proves it.
    changes = {path: diff text}: the model is told what changed and asked to cover that behaviour first."""
    out, skipped, findings = [], [], findings or {}
    requirement, changes = requirement or {}, changes or {}
    for source in files:
        lang = language_of(source)
        L = LANGS[lang]
        try:
            code = await read_file(source)
            if len(code) > 40000:
                skipped.append({"source": source, "why": "file is too large to test in one go"})
                continue
            text = get_prompt("unit_test_gen", "shared")["text"]
            flagged = findings.get(source, [])
            req = requirement.get("key", "")
            extra = ""
            if requirement.get("text") or req:
                extra += f"REQUIREMENT {req}: {str(requirement.get('text') or '')[:1500]}\nWrite tests that prove this requirement. Put the key {req or '(none)'} in every test name (use an underscore instead of a dash where the language does not allow one, e.g. {req.replace('-', '_') if req else 'REQ_1'}).\n"
            if changes.get(source):
                extra += f"CHANGED LINES IN THIS FILE (a diff; cover the changed behaviour first, including the edge cases the change introduces):\n{str(changes[source])[:6000]}\n"
            r = await call_json(f"{text}\n\n{extra}LANGUAGE: {lang}\nFRAMEWORK: {L['framework']}\nSOURCE FILE: {source}\nTEST FILE: {L['test'](source)}\n"
                                + (("SEMGREP FINDINGS IN THIS FILE (include a test that fails while this code is still vulnerable):\n- " + "\n- ".join(flagged) + "\n") if flagged else "") + f"\nSOURCE:\n{code}")
            body = _strip_fence(r if isinstance(r, str) else (r or {}).get("code") or (r or {}).get("test") or (r or {}).get("content"))
            if not body.strip():
                skipped.append({"source": source, "why": "the model returned no test code"})
                continue
            if not re.search(SHAPE[lang], body):
                skipped.append({"source": source, "why": f"the answer has no {L['framework']} test in it"})
                continue
            sx = syntax(lang, body)
            if not sx["ok"]:
                skipped.append({"source": source, "why": f"syntax error: {sx.get('why')}"})
                continue
            out.append({"path": L["test"](source), "source": source, "language": lang, "content": body if body.endswith("\n") else body + "\n", "flagged": len(flagged), "requirement": requirement.get("key", ""), "changed": bool(changes.get(source)),
                        "checks": {"syntax": "not checked (no toolchain here)" if sx.get("unchecked") else "ok"}})
        except Exception as e:
            skipped.append({"source": source, "why": str(e)})
    return {"files": out, "skipped": skipped}


# ---- API-layer integration tests: one test file per source file that serves calls, with test data built from the schema (api_layer.py)
def api_test_path(lang, source):
    d, b = posixpath.dirname(source), posixpath.splitext(posixpath.basename(source))[0]
    if lang == "javascript":
        return posixpath.join(d, b + ".api.integration.test.js")
    if lang == "typescript":
        return posixpath.join(d, b + ".api.integration.test.ts")
    if lang == "python":
        return posixpath.join("tests", f"test_{b}_api_integration.py")
    if lang == "java":
        return re.sub(r"\.java$", "ApiIT.java", re.sub(r"(^|/)src/main/", r"\1src/test/", source))
    if lang == "go":
        return posixpath.join(d, b + "_api_integration_test.go")
    if lang == "php":
        return posixpath.join("tests", "Integration", b + "ApiTest.php")
    return re.sub(r"\.cs$", "ApiTests.cs", source)


def mark_integration(lang, body):
    """The run connectors tell unit from integration by a marker per language. Add it when the model forgot it; returns (body, ok)."""
    if lang == "python":
        if re.search(r"mark\.integration", body):
            return body, True
        return ("import pytest\npytestmark = pytest.mark.integration\n" + body, True) if "from __future__" not in body else (body, False)
    if lang == "go":
        return (body, True) if re.match(r"\s*//go:build\s+integration", body) else ("//go:build integration\n\n" + body, True)
    if lang == "php":
        if re.search(r"@group\s+integration|Group\(\s*['\"]integration", body, re.I):
            return body, True
        new = re.sub(r"(\n)((?:final\s+|abstract\s+)?class\s)", r"\1/** @group integration */\n\2", body, count=1)
        return (new, new != body)
    if lang == "csharp":
        if re.search(r"Trait\(\s*\"Category\"\s*,\s*\"Integration\"", body):
            return body, True
        new = re.sub(r"(\n)((?:public\s+)?(?:sealed\s+)?class\s)", r'\1[Trait("Category", "Integration")]\n\2', body, count=1)
        return (new, new != body)
    return body, True   # JavaScript/TypeScript: the file name carries it; Java: the *IT.java name


def _compact(e):
    keep = {k: e[k] for k in ("method", "path", "pathParams", "summary", "query", "line") if e.get(k)}
    keep["testData"] = e.get("testData")
    keep["responseShape"] = {k: v for k, v in (e.get("responses") or {}).items() if v}
    if e.get("source") == "code":
        keep["code"] = e.get("snippet", "")
    return keep


async def generate_api_tests(endpoints, read_file, call_json, get_prompt, syntax=syntax_check, requirement=None, base_env="API_BASE_URL"):
    """endpoints: api_layer.analyse()['endpoints']. One integration test file per source file; the tests read the base URL from the environment,
    skip when it is not set, and check status, the shape of the data given back, and the invalid-input cases from the test data."""
    requirement = requirement or {}
    out, skipped, by_file = [], [], {}
    for e in endpoints:
        by_file.setdefault(e["file"], []).append(e)
    for source, eps in by_file.items():
        lang = language_of(source)
        if not lang:                        # an OpenAPI file: tests go next to the first language we can find in the repo, chosen by the caller
            continue
        L = LANGS[lang]
        try:
            text = get_prompt("api_test_gen", "shared")["text"]
            req = requirement.get("key", "")
            extra = f"REQUIREMENT {req}: {str(requirement.get('text') or '')[:1200]}\nPut the key {req} in every test name (underscore instead of a dash where the language needs it).\n" if req else ""
            r = await call_json(f"{text}\n\n{extra}LANGUAGE: {lang}\nFRAMEWORK: {L['framework']} (use the language's standard HTTP client; no extra library unless the framework already needs it)\nBASE URL: read it from the environment variable {base_env}; skip every test when it is not set\n"
                                f"SOURCE FILE: {source}\nTEST FILE: {api_test_path(lang, source)}\nCALLS (JSON, with test data built from the schema):\n{json.dumps([_compact(e) for e in eps[:12]], indent=1)[:14000]}")
            body = _strip_fence(r if isinstance(r, str) else (r or {}).get("code") or (r or {}).get("test") or (r or {}).get("content"))
            if not body.strip():
                skipped.append({"source": source, "why": "the model returned no API test code"})
                continue
            if not re.search(SHAPE[lang], body):
                skipped.append({"source": source, "why": f"the answer has no {L['framework']} test in it"})
                continue
            body, marked = mark_integration(lang, body)
            if not marked:
                skipped.append({"source": source, "why": "could not mark the tests as integration tests"})
                continue
            sx = syntax(lang, body)
            if not sx["ok"]:
                skipped.append({"source": source, "why": f"syntax error: {sx.get('why')}"})
                continue
            out.append({"path": api_test_path(lang, source), "source": source, "language": lang, "kind": "integration", "layer": "api", "content": body if body.endswith("\n") else body + "\n",
                        "requirement": req, "calls": [f"{e['method']} {e['path']}" for e in eps[:12]], "changed": False, "flagged": 0,
                        "checks": {"syntax": "not checked (no toolchain here)" if sx.get("unchecked") else "ok"}})
        except Exception as ex:
            skipped.append({"source": source, "why": str(ex)})
    return {"files": out, "skipped": skipped}
