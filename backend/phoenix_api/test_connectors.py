"""Connectors that RUN a repo's unit tests and unit-integration tests, language by language, and turn the results into one shape.
Languages: javascript, typescript, python, java, go, csharp, php (the same ones the AI writes tests for, see unit_tests.py).
Kinds: unit | integration. How a test is told apart is a convention per language, and it is shown to the user (see CONVENTIONS):
  python      pytest marker `integration`            javascript  files named *.integration.test.js (node:test)
  typescript  files named *.integration.* (vitest)   java        Maven: unit = surefire (mvn test), integration = failsafe (mvn verify)
  go          build tag `integration`                csharp      xUnit [Trait("Category","Integration")]
A test is tied to a requirement when its name (or class) carries a requirement key such as PROJ-123 or REQ-7; that is how a requirement is followed from
the case down to the code that proves it (lifecycle.py). Nothing here installs a toolchain: a missing one is reported as unavailable, never as a pass."""
import json
import glob
import os
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET

KEY = re.compile(r"(?<![A-Z0-9])([A-Z][A-Z0-9]{1,9})[-_](\d+)(?!\d)")  # PROJ-12, REQ_7 and Go-style TestREQ_7 (Go names cannot hold a dash)
LANGUAGES = ("javascript", "typescript", "python", "java", "go", "csharp", "php", "perl", "rust")
KINDS = ("unit", "integration")
TOOL = {"javascript": "node", "typescript": "npx", "python": "python3", "java": "mvn", "go": "go", "csharp": "dotnet", "php": "php", "perl": "prove", "rust": "cargo"}
MARKERS = {"python": ("pyproject.toml", "requirements.txt", "setup.py", "pytest.ini"), "javascript": ("package.json",), "java": ("pom.xml", "build.gradle"), "rust": ("Cargo.toml",), "perl": ("cpanfile", "Makefile.PL", "Build.PL", "dist.ini"), "php": ("composer.json", "phpunit.xml", "phpunit.xml.dist"), "go": ("go.mod",)}
CONVENTIONS = {
    "python": "pytest; integration tests are marked @pytest.mark.integration, unit tests are everything else",
    "javascript": "node:test; integration tests are files named *.integration.test.js",
    "typescript": "vitest; integration tests are files named *.integration.test.ts",
    "java": "Maven; unit = surefire (mvn test), integration = failsafe (mvn verify, *IT.java)",
    "go": "go test; integration tests carry the build tag `integration`",
    "php": "PHPUnit (vendor/bin/phpunit); integration tests are in the `integration` testsuite or carry @group integration",
    "rust": "cargo test; AI-written unit tests are tests/unit_*.rs, integration tests are tests/integration_*.rs (in-source #[cfg(test)] tests run as unit too)",
    "perl": "Test::More run with prove; integration tests live in t/integration/, unit tests in t/ (only if Perl is installed)",
    "csharp": "xUnit; integration tests have [Trait(\"Category\", \"Integration\")]",
}


def detect_languages(root):
    found = [lang for lang, files in MARKERS.items() if any(os.path.exists(os.path.join(root, f)) for f in files)]
    if "javascript" in found and any(os.path.exists(os.path.join(root, f)) for f in ("tsconfig.json",)):
        found.append("typescript")
        found.remove("javascript")  # a TypeScript project is run once, as TypeScript
    for dp, dn, fn in os.walk(root):
        dn[:] = [d for d in dn if d not in ("node_modules", ".git", "vendor", "target", "bin", "obj")]
        if any(f.endswith(".csproj") or f.endswith(".sln") for f in fn):
            found.append("csharp")
            break
        if dp.count(os.sep) - root.count(os.sep) > 3:
            dn[:] = []
    return list(dict.fromkeys(found))


def availability(which=shutil.which):
    return {lang: {"tool": TOOL[lang], "available": bool(which(TOOL[lang])), "convention": CONVENTIONS[lang]} for lang in LANGUAGES}


def _ts_framework(root):
    """nestjs | angular-jest | angular (Karma) | None, from the checkout's package.json."""
    try:
        j = json.load(open(os.path.join(root, "package.json"), encoding="utf8"))
    except (OSError, ValueError):
        return None
    d = {**(j.get("dependencies") or {}), **(j.get("devDependencies") or {})}
    if "@nestjs/core" in d:
        return None if ("vitest" in d and "jest" not in d) else "nestjs"  # newer NestJS starters use Vitest
    if "@angular/core" in d:
        if "vitest" in d and "jest" not in d and "karma" not in d:
            return None  # newer Angular projects use Vitest
        return "angular-jest" if ("jest" in d or "jest-preset-angular" in d) else "angular"
    return None


def parse_jest_json(text):
    try:
        j = json.loads(text)
    except ValueError:
        return []
    return [_t(a.get("fullName") or a.get("title"), {"passed": "passed", "failed": "failed"}.get(a.get("status"), "skipped"), int(a.get("duration") or 0)) for r in j.get("testResults", []) for a in r.get("assertionResults", [])]


def parse_cargo(text):
    return [_t(m.group(1), {"ok": "passed", "FAILED": "failed"}.get(m.group(2), "skipped")) for m in re.finditer(r"^test (\S+) \.\.\. (ok|FAILED|ignored)", text, re.M)]


def parse_tap(text):
    out = []
    for line in text.splitlines():
        m = re.match(r"^(not ok|ok)\s+\d+\s*(?:-\s*)?(.*)$", line)
        if not m:
            continue
        name, skip = m.group(2), bool(re.search(r"#\s*skip", m.group(2), re.I))
        name = re.sub(r"\s*#\s*(skip|todo).*$", "", name, flags=re.I).strip() or "test"
        out.append(_t(name, "skipped" if skip else "passed" if m.group(1) == "ok" else "failed"))
    return out


# ---- commands: (argv, where the result file is, parser name)
def command(lang, kind, out, root=None):
    if lang == "python":
        return ["python3", "-m", "pytest", "-q", "-m", "integration" if kind == "integration" else "not integration", f"--junitxml={out}"], out, "junit"
    if lang == "javascript":
        pat = "**/*.integration.test.js" if kind == "integration" else "**/*.test.js"
        args = ["node", "--test", "--test-reporter=junit", f"--test-reporter-destination={out}"]
        return args + ([pat] if kind == "integration" else [pat, "--test-skip-pattern=__none__"]), out, "junit"
    if lang == "rust":
        if kind == "integration":
            return ["cargo", "test", "--test", "integration_*"], None, "cargo"
        has_unit = bool(root) and bool(glob.glob(os.path.join(root, "tests", "unit_*.rs")))
        return (["cargo", "test", "--lib", "--bins", "--test", "unit_*"] if has_unit else ["cargo", "test"]), None, "cargo"
    if lang == "perl":
        return ["prove", "-v", *(["-r", "t/integration"] if kind == "integration" else ["t"])], None, "tap"
    if lang == "typescript" and root and _ts_framework(root) in ("nestjs", "angular-jest"):
        if _ts_framework(root) == "nestjs":
            a = ["--config", "test/jest-e2e.json"] if kind == "integration" else ["--testPathIgnorePatterns", "e2e"]
        else:
            a = ["--testPathPattern", "integration"] if kind == "integration" else ["--testPathIgnorePatterns", "integration"]
        return ["npx", "jest", "--ci", *a, "--json", f"--outputFile={out}"], out, "jestjson"
    if lang == "typescript" and root and _ts_framework(root) == "angular":
        sel = ["--include=**/*.integration.spec.ts"] if kind == "integration" else ["--exclude=**/*.integration.spec.ts"]
        return ["npx", "ng", "test", "--watch=false", "--browsers=ChromeHeadless", "--reporters=junit", *sel], out, "junit"
    if lang == "typescript":
        flt = ["integration"] if kind == "integration" else ["--exclude", "**/*.integration.*"]
        return ["npx", "vitest", "run", "--reporter=junit", f"--outputFile={out}", *flt], out, "junit"
    if lang == "java":
        return (["mvn", "-B", "-q", "verify"] if kind == "integration" else ["mvn", "-B", "-q", "test"]), os.path.join("target", "failsafe-reports" if kind == "integration" else "surefire-reports"), "junit-dir"
    if lang == "go":
        return ["go", "test", "-json", *(["-tags", "integration"] if kind == "integration" else []), "./..."], None, "gojson"
    if lang == "php":
        runner = "vendor/bin/phpunit" if root and os.path.exists(os.path.join(root, "vendor", "bin", "phpunit")) else "phpunit"
        return ["php", runner, *(["--group", "integration"] if kind == "integration" else ["--exclude-group", "integration"]), "--log-junit", out], out, "junit"
    if lang == "csharp":
        return ["dotnet", "test", "--filter", "Category=Integration" if kind == "integration" else "Category!=Integration", "--logger", f"trx;LogFileName={os.path.basename(out)}", "--results-directory", os.path.dirname(out)], out, "trx"
    raise ValueError(f"Unknown language '{lang}'. Choose from {', '.join(LANGUAGES)}.")


def _ms(v):
    try:
        return int(float(v) * 1000)
    except (TypeError, ValueError):
        return 0


def _t(name, status, ms=0):
    m = KEY.search(name or "")
    return {"name": (name or "")[:200], "status": status, "ms": ms, "requirement": f"{m.group(1)}-{m.group(2)}" if m else ""}


def parse_junit(xml_text):
    out = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return out
    for tc in root.iter("testcase"):
        name = f"{tc.get('classname') or ''} {tc.get('name') or ''}".strip()
        st = "failed" if (tc.find("failure") is not None or tc.find("error") is not None) else "skipped" if tc.find("skipped") is not None else "passed"
        out.append(_t(name, st, _ms(tc.get("time"))))
    return out


def parse_trx(xml_text):
    out = []
    try:
        root = ET.fromstring(re.sub(r'\sxmlns="[^"]+"', "", xml_text, count=1))
    except ET.ParseError:
        return out
    for r in root.iter("UnitTestResult"):
        o = (r.get("outcome") or "").lower()
        out.append(_t(r.get("testName"), "passed" if o == "passed" else "skipped" if o in ("notexecuted", "skipped", "inconclusive") else "failed"))
    return out


def parse_go_json(text):
    out = []
    for line in text.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("Action") in ("pass", "fail", "skip") and e.get("Test"):
            out.append(_t(f"{e.get('Package', '')}.{e['Test']}", {"pass": "passed", "fail": "failed", "skip": "skipped"}[e["Action"]], _ms(e.get("Elapsed"))))
    return out


def summarize(tests):
    c = {s: sum(1 for t in tests if t["status"] == s) for s in ("passed", "failed", "skipped")}
    ran = c["passed"] + c["failed"]
    return {"total": len(tests), **c, "passRate": round(c["passed"] / ran, 3) if ran else None, "requirements": sorted({t["requirement"] for t in tests if t["requirement"]})}


def _python_env(root, tmp):
    """A throwaway virtualenv with pytest and the project's own dependencies, so its tests can import them."""
    venv = os.path.join(tmp, "venv")
    py = os.path.join(venv, "bin", "python")
    try:
        if subprocess.run(["python3", "-m", "venv", venv], capture_output=True, timeout=120).returncode:
            return None
        pip = [py, "-m", "pip", "install", "-q", "--disable-pip-version-check"]
        subprocess.run(pip + ["pytest"], capture_output=True, timeout=300)
        for f in sorted(glob.glob(os.path.join(root, "requirements*.txt")))[:4]:
            subprocess.run(pip + ["-r", f], capture_output=True, timeout=600)
        if os.path.exists(os.path.join(root, "pyproject.toml")) or os.path.exists(os.path.join(root, "setup.py")):
            for extra in (".[tests,test,dev]", ".[test]", ".[dev]", "."):
                if subprocess.run(pip + ["-e", extra], cwd=root, capture_output=True, timeout=600).returncode == 0:
                    break
            for grp in ("dev", "tests", "test"):
                subprocess.run(pip + ["--group", grp], cwd=root, capture_output=True, timeout=600)
        return py
    except (OSError, subprocess.SubprocessError):
        return None


def run_tests(lang, kind, root, run=subprocess.run, which=shutil.which, timeout=900, env=None):
    """Run one language and kind in a checkout. Never raises: returns {ok, available, detail, tests, summary}."""
    if lang not in LANGUAGES or kind not in KINDS:
        raise ValueError(f"language is one of {', '.join(LANGUAGES)}; kind is unit or integration.")
    tool = TOOL[lang]
    if not which(tool):
        return {"language": lang, "kind": kind, "ok": False, "available": False, "detail": f"{tool} is not installed here, so {lang} {kind} tests cannot run", "tests": [], "summary": summarize([])}
    tmp = tempfile.mkdtemp(prefix="phx-ut-")
    out = os.path.join(tmp, "result.xml")
    argv, where, parser = command(lang, kind, out, root)
    try:
        if lang == "python" and run is subprocess.run and os.environ.get("PHOENIX_PY_VENV", "1") == "1":
            py = _python_env(root, tmp)
            if py:
                argv[0] = py
        if lang == "python":  # src-layout projects need their own code importable
            env = dict(env or os.environ)
            env["PYTHONPATH"] = os.pathsep.join(x for x in (root, os.path.join(root, "src"), env.get("PYTHONPATH", "")) if x)
        if lang == "php" and os.path.exists(os.path.join(root, "composer.json")) and not os.path.exists(os.path.join(root, "vendor", "bin", "phpunit")) and which("composer"):
            c = run(["composer", "install", "--no-interaction", "--no-progress", "--quiet"], cwd=root, capture_output=True, text=True, timeout=timeout)
            if getattr(c, "returncode", 0):  # often a PHP-version limit in the lock file: retry ignoring it
                run(["composer", "install", "--no-interaction", "--no-progress", "--quiet", "--ignore-platform-reqs"], cwd=root, capture_output=True, text=True, timeout=timeout)
            argv, where, parser = command(lang, kind, out, root)
        p = run(argv, cwd=root, capture_output=True, text=True, timeout=timeout, **({"env": env} if env else {}))
        if parser == "gojson":
            tests = parse_go_json(p.stdout or "")
        elif parser == "cargo":
            tests = parse_cargo(p.stdout or "")
        elif parser == "tap":
            tests = parse_tap(p.stdout or "")
        elif parser == "jestjson":
            tests = parse_jest_json(open(out, encoding="utf8").read()) if os.path.exists(out) else []
        elif parser == "junit-dir":
            d = os.path.join(root, where)
            tests = [t for f in sorted(os.listdir(d)) if f.endswith(".xml") for t in parse_junit(open(os.path.join(d, f), encoding="utf8").read())] if os.path.isdir(d) else []
        else:
            path = out if os.path.exists(out) else next((os.path.join(tmp, f) for f in os.listdir(tmp) if f.endswith((".xml", ".trx"))), None)
            body = open(path, encoding="utf8").read() if path else ""
            tests = parse_trx(body) if parser == "trx" else parse_junit(body)
        s = summarize(tests)
        if not tests:
            tail = ((p.stderr or "") + (p.stdout or ""))[-300:].strip()
            return {"language": lang, "kind": kind, "ok": False, "available": True, "detail": f"no {kind} tests were found or the run produced no result: {tail}", "tests": [], "summary": s}
        return {"language": lang, "kind": kind, "ok": s["failed"] == 0, "available": True, "detail": f"{s['passed']} passed, {s['failed']} failed, {s['skipped']} skipped", "tests": tests, "summary": s}
    except subprocess.TimeoutExpired:
        return {"language": lang, "kind": kind, "ok": False, "available": True, "detail": f"timed out after {timeout}s", "tests": [], "summary": summarize([])}
    except (OSError, ValueError) as e:
        return {"language": lang, "kind": kind, "ok": False, "available": True, "detail": str(e)[:200], "tests": [], "summary": summarize([])}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def run_all(root, languages=None, kinds=("unit", "integration"), run=subprocess.run, which=shutil.which, env=None):
    langs = [l for l in (languages or detect_languages(root)) if l in LANGUAGES]
    if not langs:
        return []
    return [run_tests(l, k, root, run, which, env=env) for l in langs for k in kinds]


def clone(url, ref="", dest=None, run=subprocess.run):
    """Shallow clone for a run (HTTPS only; no credentials are logged)."""
    if not re.match(r"^https://[\w.-]+/[\w./~-]+$", url or ""):
        raise ValueError("cloneUrl must be an https:// repository URL")
    dest = dest or tempfile.mkdtemp(prefix="phx-repo-")
    argv = ["git", "clone", "--depth", "1", *(["--branch", ref] if ref else []), url, dest]
    p = run(argv, capture_output=True, text=True, timeout=300)
    if p.returncode != 0:
        raise ValueError("git clone failed: " + (p.stderr or "")[-200:].replace(url, "<repo>"))
    return dest
