"""Playwright flow (UI tests with mock UI/UX data).

A UI case is {requirement, url, steps:[{action:'fill'|'click'|'expect_text'|'expect_visible', selector, value?}],
              mock_api:[{method, url_glob, status, body}]}.
build_spec(cases)   -> Playwright test file (TypeScript). API calls named in mock_api are answered from the mock, so the page
                       is judged on what it sends (input) and shows (output), not on a live back end.
run_specs(dir)      -> normalized {ok, available, tests:[{name, status, error}], summary, log}
draft_cases(requirements, call_json=None, base_url='') -> cases from requirements (model if given, else a marked draft)
"""
import json

from .sync_ask import ask
import os
import shutil
import subprocess

PROMPT = ("You write Playwright UI cases. For each requirement give page url, steps (fill/click/expect_text/expect_visible with CSS selectors) "
          'and mock_api entries (method, url_glob, status, body). Reply JSON: {"cases":[{"requirement":"","url":"","steps":[],"mock_api":[]}]}')


def draft_cases(requirements, call_json=None, base_url="", context=""):
    cases = []
    if call_json:
        try:
            out = ask(call_json, PROMPT, json.dumps({"requirements": requirements, "base_url": base_url, "context": context[:6000]}))
            cases = [c for c in (out or {}).get("cases", []) if c.get("requirement") and c.get("url")]
            for c in cases:
                c["source"] = "model"
        except Exception:
            cases = []
    have = {c["requirement"] for c in cases}
    for r in requirements:
        k = r.get("key") if isinstance(r, dict) else str(r)
        if k not in have:
            cases.append({"requirement": k, "url": base_url or "/", "steps": [{"action": "expect_visible", "selector": "body"}], "mock_api": [],
                          "source": "draft: only checks the page opens; Akash/QA add the steps and mock data"})
    return cases


def _step(s):
    sel, val = json.dumps(s.get("selector", "body")), json.dumps(s.get("value", ""))
    return {"fill": f"await page.fill({sel}, {val});", "click": f"await page.click({sel});",
            "expect_text": f"await expect(page.locator({sel})).toContainText({val});",
            "expect_visible": f"await expect(page.locator({sel}).first()).toBeVisible();"}.get(s.get("action"), "// unknown step skipped")


def build_spec(cases):
    out = ["import { test, expect } from '@playwright/test';", ""]
    for c in cases:
        out.append(f"test({json.dumps(c['requirement'] + ' - ' + c.get('url', ''))}, async ({{ page }}) => {{")
        for m in c.get("mock_api", []):
            out.append(f"  await page.route({json.dumps(m['url_glob'])}, r => r.fulfill({{ status: {int(m.get('status', 200))}, contentType: 'application/json', body: JSON.stringify({json.dumps(m.get('body', {}))}) }}));")
        out.append(f"  await page.goto({json.dumps(c.get('url', '/'))});")
        out += ["  " + _step(s) for s in c.get("steps", [])]
        out += ["});", ""]
    return "\n".join(out)


def available():
    return bool(shutil.which("npx"))


def write_project(dirpath, cases, base_url=""):
    os.makedirs(dirpath, exist_ok=True)
    with open(os.path.join(dirpath, "ui.spec.ts"), "w") as fh:
        fh.write(build_spec(cases))
    with open(os.path.join(dirpath, "playwright.config.ts"), "w") as fh:
        fh.write("import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: '.', reporter: [['json']], "
                 f"use: {{ {('baseURL: ' + json.dumps(base_url)) if base_url else ''} }} }});\n")


def parse(report):
    tests = []

    def walk(s):
        for sp in s.get("specs", []):
            for t in sp.get("tests", []):
                res = (t.get("results") or [{}])[-1]
                st = res.get("status") or t.get("status", "unknown")
                err = ((res.get("error") or {}).get("message") or "")[:400]
                tests.append({"name": sp.get("title", ""), "status": "passed" if st == "passed" else ("skipped" if st == "skipped" else "failed"), "error": err})
        for c in s.get("suites", []):
            walk(c)
    for s in report.get("suites", []):
        walk(s)
    p, f = sum(t["status"] == "passed" for t in tests), sum(t["status"] == "failed" for t in tests)
    return {"tests": tests, "summary": {"passed": p, "failed": f, "total": len(tests)}}


def run_specs(dirpath, timeout=300):
    if not available():
        return {"ok": False, "available": False, "detail": "npx / Playwright not installed on this runner", "tests": [], "summary": {}, "log": ""}
    try:
        cmd = os.environ.get("PHOENIX_PLAYWRIGHT_CMD", "npx --no-install playwright test").split()
        r = subprocess.run(cmd, cwd=dirpath, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"ok": False, "available": True, "detail": "timed out", "tests": [], "summary": {}, "log": ""}
    try:
        rep = parse(json.loads(r.stdout))
    except ValueError:
        return {"ok": False, "available": True, "detail": "no report; is @playwright/test installed here?", "tests": [], "summary": {}, "log": (r.stdout + r.stderr)[-3000:]}
    ok = rep["summary"]["failed"] == 0 and rep["summary"]["total"] > 0
    return {"ok": ok, "available": True, "detail": "", **rep, "log": "" if ok else (r.stdout + r.stderr)[-3000:]}
