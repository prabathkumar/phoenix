"""The monitoring dashboard: test execution, test-case sign-off, and AI health in one answer.
Execution and sign-off come from Postgres; AI calls, evals and stage timings come from ClickHouse (or memory, labelled)."""
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy import func

from . import analytics, db, run_record, signoff
from .db import Execution, Signoff, TestCase


def summary(days=14, url=None):
    since = datetime.now(timezone.utc) - timedelta(days=days)
    with db.session(url) as s:
        rows = s.query(Execution).filter(Execution.at >= since).all()
        pending = s.query(Signoff).filter_by(status="pending").order_by(Signoff.id).all()
        pend = [{"id": p.id, "kind": p.kind, "subject": p.subject, "requestedBy": p.requested_by, "since": p.created_at.isoformat()} for p in pending]
        total_cases = s.query(func.count(TestCase.id)).scalar()
    per_day = defaultdict(lambda: {"passed": 0, "failed": 0, "other": 0})
    by_who = defaultdict(lambda: {"passed": 0, "failed": 0})
    fails = defaultdict(int)
    for e in rows:
        d = per_day[e.at.date().isoformat()]
        d[e.result if e.result in ("passed", "failed") else "other"] += 1
        if e.result in ("passed", "failed"):
            by_who[e.who][e.result] += 1
        if e.result == "failed":
            fails[e.case_id] += 1
    ran = sum(1 for e in rows if e.result in ("passed", "failed"))
    passed = sum(1 for e in rows if e.result == "passed")
    ai = analytics.default()
    a = ai.ai_summary(days)
    stage = _stage_stats(ai, days)
    return {
        "days": days,
        "execution": {"total": len(rows), "passRate": round(passed / ran, 3) if ran else None, "passed": passed, "failed": ran - passed,
                      "perDay": [{"day": d, **v} for d, v in sorted(per_day.items())], "byWho": {k: v for k, v in by_who.items()},
                      "topFailing": [{"caseId": c, "failures": n} for c, n in sorted(fails.items(), key=lambda x: -x[1])[:8]]},
        "signoff": {**signoff.funnel(url), "totalCases": total_cases, "waitingOnYou": pend},
        "ai": {**a, "stages": stage},
        "runs": run_record.list_runs(10, url),
        "stores": {"postgres": db.dialect(url), "analytics": ai.status()},
    }


def _stage_stats(ai, days):
    rows = ai._rows("stage_events", days)
    by = defaultdict(lambda: {"runs": 0, "failed": 0, "needsYou": 0, "ms": []})
    for r in rows:
        b = by[r["stage"]]
        b["runs"] += 1
        b["failed"] += r["status"] == "failed"
        b["needsYou"] += r["status"] == "needs-you"
        b["ms"].append(r.get("ms", 0))
    return [{"stage": k, "runs": v["runs"], "failed": v["failed"], "needsYou": v["needsYou"], "avgMs": int(sum(v["ms"]) / len(v["ms"])) if v["ms"] else 0} for k, v in sorted(by.items())]
