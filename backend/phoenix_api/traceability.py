"""Is what the requirements say what is being built? Reads the repo where sessions/test cases/scripts are stored and compares.
covered | partial | missing, plus 'unrequired' (tests no requirement asks for). The model judges; the code keeps it honest:
evidence must be real repo files (invented paths dropped; 'covered' with no real evidence becomes 'missing').
With no model: a word-overlap match labelled a guess ('possible')."""
import json
import re

from . import guardrails

DEFAULT_PATHS = [re.compile(p, re.I) for p in (r"(^|/)test-cases/.+\.json$", r"(^|/)generated/.+\.(js|ts|py|json)$", r"(^|/)(tests?|__tests__|e2e|sessions?|recordings?)/.+\.(js|ts|py|java|go|cs|json|feature)$",
                                               r"\.(test|spec)\.(js|ts|py)$", r"(^|/)test_.+\.py$", r"Tests?\.(java|cs)$", r"_test\.go$", r"\.feature$")]
IGNORE = re.compile(r"(^|/)(node_modules|vendor|dist|build|target|\.git)/")
STOP = set("the a an and or of to in on for with is are be must should shall can will it its this that as at by from not no all any when then user users system able".split())


def words(s):
    return [w for w in re.sub(r"[^a-z0-9 ]+", " ", str(s or "").lower()).split() if len(w) > 2 and w not in STOP]


def split_statements(text):
    parts = re.split(r"\n+|(?<=[.!?])\s+(?=[A-Z])", str(text or ""))
    out = [re.sub(r"^[\s#>*\-\d.)]+", "", p).strip() for p in parts]
    out = [s for s in out if len(s) >= 12 and re.search(r"[A-Za-z]{3}", s)][:60]
    return [{"id": f"R{i + 1}", "text": t[:300]} for i, t in enumerate(out)]


def describe_file(path, content):
    body, title = str(content or ""), ""
    if path.lower().endswith(".json"):
        try:
            j = json.loads(body)
            title = (j.get("name") or j.get("title") or j.get("testName") or "") if isinstance(j, dict) else ""
            steps = (j.get("steps") or j.get("instructions") or j.get("cases")) if isinstance(j, dict) else None
            if isinstance(steps, list):
                body = (title + "\n" if title else "") + "\n".join(s if isinstance(s, str) else str(s.get("instruction") or s.get("text") or s.get("name") or json.dumps(s)[:80]) for s in steps[:25])
        except Exception:
            pass
    else:
        m = re.search(r"(?:describe|test|it|def test_\w*|@Test[\s\S]{0,40}?void|func Test\w*|Scenario:|Feature:)\s*\(?['\"]?([^'\"\n(]{3,80})", body)
        title = m.group(1) if m else ""
    return {"path": path, "title": guardrails.redact(title)[:100], "text": guardrails.redact(body)[:700]}


async def collect_artifacts(repo, ref, paths=DEFAULT_PATHS, max=60, max_file=20000):
    files = [f for f in await repo.list_files(ref) if not IGNORE.search(f) and any(p.search(f) for p in paths)][:max]
    out = []
    for f in files:
        try:
            out.append(describe_file(f, (await repo.read_file(f, ref))[:max_file]))
        except Exception:
            pass
    return out


def lexical_match(requirements, artifacts):
    aw = [set(words(a["path"] + " " + a["title"] + " " + a["text"])) for a in artifacts]
    coverage = []
    for r in requirements:
        rw = list(dict.fromkeys(words(r["text"])))
        if not rw:
            coverage.append({"id": r["id"], "text": r["text"], "status": "missing", "evidence": [], "note": "nothing to match"})
            continue
        hits = sorted(((sum(w in aw[i] for w in rw) / len(rw), a["path"]) for i, a in enumerate(artifacts)), reverse=True)
        hits = [h for h in hits if h[0] >= 0.34][:3]
        coverage.append({"id": r["id"], "text": r["text"], "status": "possible" if hits else "missing", "evidence": [p for _, p in hits],
                         "note": "word match only: a guess, not a judgement" if hits else "no test mentions these words"})
    used = {p for c in coverage for p in c["evidence"]}
    return coverage, [{"path": a["path"], "note": "no requirement shares its words"} for a in artifacts if a["path"] not in used]


async def compare(requirements, artifacts, call_json=None):
    source, result, why = "words", None, None
    if call_json and requirements and artifacts:
        prompt = ("You check whether what is built matches the requirements. For each requirement say if a test covers it.\nREQUIREMENTS:\n" + "\n".join(f"{r['id']}: {r['text']}" for r in requirements)
                  + "\n\nTESTS AND SESSIONS IN THE REPO:\n" + "\n---\n".join(f"[{a['path']}] {a['title']}\n{a['text'][:450]}" for a in artifacts)
                  + '\n\nReply JSON {"coverage":[{"id":"R1","status":"covered|partial|missing","evidence":["path"],"note":"short reason"}],"unrequired":[{"path":"path","note":"why no requirement asks for it"}]}. Use only the paths shown. Say "covered" only if a listed test really checks it.')
        try:
            r = await call_json(prompt)
            if isinstance(r, dict) and isinstance(r.get("coverage"), list):
                result, source = r, "ai"
            else:
                why = "the model's answer could not be read"
        except Exception as e:
            why = str(e)
    if result:
        known = {a["path"] for a in artifacts}
        by = {c.get("id"): c for c in result["coverage"] if isinstance(c, dict)}
        coverage = []
        for r in requirements:
            c = by.get(r["id"], {})
            ev = [p for p in (c.get("evidence") if isinstance(c.get("evidence"), list) else []) if p in known]
            st = c.get("status") if c.get("status") in ("covered", "partial", "missing") else "missing"
            note = str(c.get("note", ""))[:240]
            if st != "missing" and not ev:
                st, note = "missing", "the model named no real file as evidence" + (f" ({note})" if note else "")
            coverage.append({"id": r["id"], "text": r["text"], "status": st, "evidence": ev, "note": note})
        unrequired = [{"path": u["path"], "note": str(u.get("note", ""))[:200]} for u in (result.get("unrequired") or []) if isinstance(u, dict) and u.get("path") in known]
    else:
        coverage, unrequired = lexical_match(requirements, artifacts)
    count = lambda s: sum(c["status"] == s for c in coverage)  # noqa: E731
    return {"source": source, **({"fellBackBecause": why} if why else {}), "coverage": coverage, "unrequired": unrequired,
            "summary": {"requirements": len(requirements), "covered": count("covered"), "partial": count("partial"), "missing": count("missing"), "possible": count("possible"), "unrequired": len(unrequired), "tests": len(artifacts)}}


async def check(requirement, repo, ref=None, call_json=None, statements=None):
    reqs = statements or None
    if not reqs and call_json:
        try:
            r = await call_json(f'List every separate thing this requirement says the product must do, one short statement each (max 40).\nREQUIREMENT:\n{str(requirement)[:8000]}\nReply JSON {{"statements":["..."]}}.')
            if isinstance(r, dict) and isinstance(r.get("statements"), list):
                reqs = [{"id": f"R{i + 1}", "text": str(t)[:300]} for i, t in enumerate(r["statements"][:40]) if str(t).strip()]
        except Exception:
            pass
    reqs = reqs or split_statements(requirement)
    base = ref or await repo.default_branch()
    arts = await collect_artifacts(repo, base)
    return {"ref": base, **(await compare(reqs, arts, call_json))}
