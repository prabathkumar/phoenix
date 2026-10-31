"""One record per pipeline run, linking the blocks that used to stand alone:
requirement -> scenarios -> cases -> data field names -> execution -> HAR -> performance -> scans -> defects (Jira keys) -> model calls (by run id).
Stored in Postgres (docs kind 'run'). Holds statuses, counts, names and keys only: no test-data values, requirement text, prompts or answers."""
import re
import secrets
from datetime import datetime, timezone

from . import db

ID = re.compile(r"^run-\d{14}-[0-9a-f]{6}$")


def new_id():
    return f"run-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(3)}"


def ok_id(i):
    return bool(ID.match(str(i)))


def link(stages, jira_key=None, goal="", plan=None, run_id="", retest=(), requirement_source=None, project=""):
    by = lambda i: next((s for s in stages if s["id"] == i), {})  # noqa: E731
    d = lambda i: by(i).get("data") or {}  # noqa: E731
    rs = requirement_source or {}
    tr = (d("traceability").get("traceability") or {}).get("summary")
    return {
        "id": run_id, "at": datetime.now(timezone.utc).isoformat(), "goal": str(goal or "")[:200], "project": project, "requirement": jira_key or None,
        "requirementSource": {k: rs.get(k) for k in ("kind", "type", "name", "host")} if rs else None,
        "traceability": tr, "aiEval": d("aieval").get("summary"), "plan": {"source": plan["source"], "platforms": plan["platforms"]} if plan else None,
        "counts": {"scenarios": len(d("scenarios").get("items", [])), "cases": len(d("cases").get("items", [])), "dataFields": len(d("testdata").get("names", []))},
        "dataFields": d("testdata").get("names", []),
        "execution": {"status": by("execution").get("status"), "detail": by("execution").get("detail"), "failedCases": d("execution").get("failedCases", [])},
        "har": {"status": by("har").get("status"), "detail": by("har").get("detail")},
        "performance": {"status": by("performance").get("status"), "detail": by("performance").get("detail")},
        "security": {"secrets": by("secrets").get("status"), "sast": by("sast").get("status"), "dast": by("dast").get("status")},
        "defects": {"keys": [x["key"] for x in d("defects").get("defects", []) if x.get("key")], "fixed": [x["key"] for x in d("defects").get("fixed", [])], "retested": list(retest)},
        "stages": [{"id": s["id"], "status": s["status"], "detail": str(s.get("detail") or "")[:200], **({"decided": s["decided"]} if s.get("decided") else {}), **({"ai": s["ai"]} if s.get("ai") else {})} for s in stages],
    }


def save(rec, url=None):
    return db.doc_put("run", rec["id"], rec, url)


def get(i, url=None):
    if not ok_id(i):
        raise ValueError("Not a run id.")
    return db.doc_get("run", i, url)


def list_runs(n=50, url=None):
    rows = sorted(db.doc_list("run", url), key=lambda r: r["id"], reverse=True)[:n]
    return [{"id": r["id"], "at": r["at"], "goal": r["goal"], "requirement": r["requirement"], "execution": r["execution"]["status"], "defects": len(r["defects"]["keys"])} for r in rows]


def prior_for(jira_key, n=5, url=None):
    if not jira_key:
        return []
    return [r for r in sorted(db.doc_list("run", url), key=lambda r: r["id"], reverse=True) if r.get("requirement") == jira_key][:n]


def brief_for(jira_key, n=5, url=None):
    out = []
    for r in prior_for(jira_key, n, url):
        failed = r["execution"].get("failedCases") or []
        out.append(f"{r['at'][:10]}: execution {r['execution']['status']}" + (f" (failed: {', '.join(c['name'] for c in failed)})" if failed else "")
                   + f"; defects {','.join(r['defects']['keys']) or 'none'}" + (f"; fixed in Jira: {','.join(r['defects']['fixed'])}" if r["defects"]["fixed"] else ""))
    return out
