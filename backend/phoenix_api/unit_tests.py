"""AI-written unit tests for several languages, wired to the repo and to Semgrep.
Languages: JavaScript, TypeScript, Python, Java, Go, C#. Semgrep findings steer file choice and go into the prompt.
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
    "csharp": {"ext": (".cs",), "framework": "xUnit", "test": lambda f: re.sub(r"\.cs$", "Tests.cs", f)},
}
IGNORE = re.compile(r"(^|/)(node_modules|vendor|dist|build|target|bin|obj|\.git|generated)/")
IS_TEST = re.compile(r"(\.test\.|\.spec\.|_test\.|(^|/)test_|Tests?\.(java|cs)$|(^|/)(tests?|__tests__)/)", re.I)
SHAPE = {"javascript": r"\b(test|it|describe)\s*\(", "typescript": r"\b(test|it|describe)\s*\(", "python": r"\bdef test_", "java": r"@Test\b", "go": r"func Test\w+\(t \*testing\.T\)", "csharp": r"\[(Fact|Theory)\]"}


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
    for r in (j or {}).get("results", []):
        f = re.sub(r"^\./", "", str(r.get("path", "")))
        out.setdefault(f, []).append(f"{str(r.get('check_id', '')).split('.')[-1]}: {str((r.get('extra') or {}).get('message', ''))[:200]} (line {(r.get('start') or {}).get('line', '?')})")
    return out


def syntax_check(lang, code, run=subprocess.run):
    try:
        if lang == "python":
            ast.parse(code)
            return {"ok": True}
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


async def generate_tests(files, read_file, call_json, get_prompt, findings=None, syntax=syntax_check):
    out, skipped, findings = [], [], findings or {}
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
            r = await call_json(f"{text}\n\nLANGUAGE: {lang}\nFRAMEWORK: {L['framework']}\nSOURCE FILE: {source}\nTEST FILE: {L['test'](source)}\n"
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
            out.append({"path": L["test"](source), "source": source, "language": lang, "content": body if body.endswith("\n") else body + "\n", "flagged": len(flagged),
                        "checks": {"syntax": "not checked (no toolchain here)" if sx.get("unchecked") else "ok"}})
        except Exception as e:
            skipped.append({"source": source, "why": str(e)})
    return {"files": out, "skipped": skipped}
