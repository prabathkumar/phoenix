"""End to end with a real model: clone a public repo, the model writes unit tests for a few files, they are run, and the model triages any failure.
Usage: python3 scripts/ai_unit_run.py <https clone url> [how many files, default 3]
Model: OLLAMA_HOST + OLLAMA_MODEL, or LLM_BASE_URL + LLM_MODEL (see backend/phoenix_api/llm.py)."""
import asyncio
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
from phoenix_api import handlers, llm, prompt_store, test_connectors as tcx, unit_tests  # noqa: E402


async def main(url, n):
    call = llm.call_json_from_env()
    if not call:
        sys.exit("No model: set OLLAMA_HOST and OLLAMA_MODEL (or LLM_BASE_URL and LLM_MODEL).")
    root = tempfile.mkdtemp(prefix="ai-unit-")
    tcx.clone(url, dest=root)
    allf = [os.path.relpath(os.path.join(d, f), root) for d, ds, fs in os.walk(root) if ".git" not in d for f in fs]
    files = unit_tests.pick_files(sorted(allf), max=n)
    print("model writes tests for:", files, flush=True)
    read = lambda f: _read(root, f)  # noqa: E731
    g = await unit_tests.generate_tests(files, read, call, prompt_store.get_prompt)
    for s in g["skipped"]:
        print("skipped", s["source"], "-", s["why"])
    for f in g["files"]:
        p = os.path.join(root, f["path"])
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "w", encoding="utf8").write(f["content"])
        print("written", f["path"])
    langs = sorted({f["language"] for f in g["files"]}) or None
    results = tcx.run_all(root, langs, ("unit",), retry=False)
    await handlers._triage_and_rerun(results, root, call, "ai-unit-run", {}, os.environ)
    for r in results:
        print(f"\n{r['language']} {r['kind']}: {r['detail']}")
        for t in r["tests"]:
            print("  ", t["status"].upper().ljust(7), t["name"], "(flaky)" if t.get("flaky") else "")
        for t in r.get("triage", []):
            print("   model says:", t["name"], "->", t["verdict"], "-", t["reason"])
    print("\nchecked out at", root)


async def _read(root, f):
    return open(os.path.join(root, f), encoding="utf8", errors="replace").read()


asyncio.run(main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 3))
