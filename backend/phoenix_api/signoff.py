"""Sign-off: nothing is released on the AI's say-so. People approve, with a trail.
Test case: draft -> (request) pending -> approved | rejected | changes-requested. Editing an approved case sends it back to draft.
Run (release): pending -> approved | rejected. Approval is allowed only when the checks pass, or with an explicit 'approve with exceptions' note that is recorded.
Four eyes: the person who asked for sign-off cannot approve it (set PHOENIX_ALLOW_SELF_SIGNOFF=true to turn that off on a small team).
Every action appends to an audit trail that is never edited or deleted. The actor comes from the signed-in user (X-User header today; real login is the next step)."""
import os

from sqlalchemy import func

from . import analytics, db
from .db import Execution, Signoff, SignoffEvent, TestCase

CASE_STATES = ("draft", "pending", "approved", "rejected", "changes-requested")


class SignoffError(ValueError):
    pass


def _actor(a):
    a = str(a or "").strip()
    if not a:
        raise SignoffError("Say who you are (the signed-in user) to sign off.")
    return a[:120]


def _event(s, sid, action, actor, note=""):
    s.add(SignoffEvent(signoff_id=sid, action=action, actor=actor, note=str(note or "")[:2000]))


# ---- test cases
def upsert_case(id, title, steps=None, project="", requirement="", priority="Medium", who="ai", url=None):
    with db.session(url) as s:
        c = s.get(TestCase, id)
        if c is None:
            s.add(TestCase(id=id, title=title[:300], steps=steps or [], project=project, requirement=requirement, priority=priority, who=who))
        else:
            changed = (c.title != title[:300]) or (steps is not None and c.steps != steps)
            c.title, c.project, c.requirement, c.priority, c.who = title[:300], project or c.project, requirement or c.requirement, priority, who
            if steps is not None:
                c.steps = steps
            if changed and c.signoff in ("approved", "pending"):
                c.signoff = "draft"  # an edited case needs a new approval
                for so in s.query(Signoff).filter_by(kind="case", subject=id, status="pending").all():
                    so.status, so.note = "changes-requested", "case was edited; request sign-off again"
        s.commit()
        return _case(s.get(TestCase, id))


def _case(c):
    return {"id": c.id, "project": c.project, "requirement": c.requirement, "title": c.title, "steps": c.steps, "priority": c.priority, "who": c.who, "signoff": c.signoff}


def list_cases(project=None, requirement=None, signoff=None, url=None):
    with db.session(url) as s:
        q = s.query(TestCase)
        for col, v in ((TestCase.project, project), (TestCase.requirement, requirement), (TestCase.signoff, signoff)):
            if v:
                q = q.filter(col == v)
        return [_case(c) for c in q.order_by(TestCase.id).all()]


def request_case(case_id, actor, note="", url=None):
    actor = _actor(actor)
    with db.session(url) as s:
        c = s.get(TestCase, case_id)
        if not c:
            raise SignoffError(f"No test case {case_id}.")
        if c.signoff == "pending":
            raise SignoffError("Sign-off is already requested for this case.")
        so = Signoff(kind="case", subject=case_id, status="pending", requested_by=actor, note=str(note)[:2000])
        s.add(so)
        s.flush()
        _event(s, so.id, "requested", actor, note)
        c.signoff = "pending"
        s.commit()
        return _view(s, so)


def decide(signoff_id, decision, actor, note="", url=None, env=None):
    """decision: approved | rejected | changes-requested. Rejecting or asking for changes needs a note saying why."""
    env = env if env is not None else os.environ
    actor = _actor(actor)
    if decision not in ("approved", "rejected", "changes-requested"):
        raise SignoffError("Decision is approved, rejected or changes-requested.")
    if decision != "approved" and not str(note).strip():
        raise SignoffError("Say why when you reject or ask for changes.")
    with db.session(url) as s:
        so = s.get(Signoff, signoff_id)
        if not so:
            raise SignoffError("No such sign-off.")
        if so.status != "pending":
            raise SignoffError(f"This sign-off is already {so.status}.")
        if actor.lower() == so.requested_by.lower() and str(env.get("PHOENIX_ALLOW_SELF_SIGNOFF", "")).lower() != "true":
            raise SignoffError("The person who asked for sign-off cannot approve it. Ask a colleague.")
        if so.kind == "run" and decision == "approved":
            checks = run_checks(so.subject, url)
            if not checks["pass"] and not str(note).strip():
                raise SignoffError("The release checks do not all pass. Approve with exceptions by writing why in the note, or reject.")
            if not checks["pass"]:
                _event(s, so.id, "exceptions-accepted", actor, "Failing checks: " + "; ".join(c["name"] for c in checks["checks"] if not c["ok"]))
        so.status, so.decided_by, so.note, so.decided_at = decision, actor, str(note)[:2000], db.now()
        _event(s, so.id, decision, actor, note)
        if so.kind == "case":
            c = s.get(TestCase, so.subject)
            if c:
                c.signoff = {"approved": "approved", "rejected": "rejected", "changes-requested": "changes-requested"}[decision]
        s.commit()
        return _view(s, so)


def _view(s, so):
    ev = s.query(SignoffEvent).filter_by(signoff_id=so.id).order_by(SignoffEvent.id).all()
    return {"id": so.id, "kind": so.kind, "subject": so.subject, "status": so.status, "requestedBy": so.requested_by, "decidedBy": so.decided_by, "note": so.note,
            "createdAt": so.created_at.isoformat(), "decidedAt": so.decided_at.isoformat() if so.decided_at else None,
            "trail": [{"action": e.action, "actor": e.actor, "note": e.note, "at": e.at.isoformat()} for e in ev]}


def list_signoffs(kind=None, status=None, subject=None, url=None):
    with db.session(url) as s:
        q = s.query(Signoff)
        for col, v in ((Signoff.kind, kind), (Signoff.status, status), (Signoff.subject, subject)):
            if v:
                q = q.filter(col == v)
        return [_view(s, so) for so in q.order_by(Signoff.id.desc()).limit(200).all()]


# ---- executions
def record_execution(run_id, case_id, result, who="ai", where="", detail="", ms=0, url=None):
    if result not in ("passed", "failed", "blocked", "skipped"):
        raise SignoffError("Result is passed, failed, blocked or skipped.")
    with db.session(url) as s:
        s.add(Execution(run_id=run_id, case_id=case_id, result=result, who=who, where=where[:120], detail=str(detail)[:2000], ms=int(ms)))
        s.commit()
    analytics.default().insert("executions", {"run": run_id, "case_id": case_id, "result": result, "who": who, "ms": int(ms)})


def executions_for(run_id, url=None):
    with db.session(url) as s:
        return [{"caseId": e.case_id, "result": e.result, "who": e.who, "where": e.where, "detail": e.detail, "at": e.at.isoformat()} for e in s.query(Execution).filter_by(run_id=run_id).order_by(Execution.id).all()]


# ---- run (release) sign-off
def run_checks(run_id, url=None):
    """The checks a release sign-off is judged on. Computed from real records; nothing is assumed."""
    from . import run_record
    rec = run_record.get(run_id, url) if run_record.ok_id(run_id) else None
    if not rec:
        return {"pass": False, "checks": [{"name": "Run exists", "ok": False, "detail": "No such run."}]}
    ex = executions_for(run_id, url)
    last = {}
    for e in ex:
        last[e["caseId"]] = e["result"]
    # The cases this release is judged on: everything under its requirement, plus every case that was actually executed in the run.
    cases = {c["id"]: c for c in (list_cases(requirement=rec.get("requirement"), url=url) if rec.get("requirement") else [])}
    for c in list_cases(url=url):
        if c["id"] in last:
            cases[c["id"]] = c
    cases = list(cases.values())
    failed = [c for c, r in last.items() if r == "failed"]
    defect_n = len(rec["defects"]["keys"])
    sec = rec["security"]
    tr = rec.get("traceability") or {}
    checks = [
        {"name": "Cases approved", "ok": bool(cases) and all(c["signoff"] == "approved" for c in cases), "detail": f"{sum(c['signoff'] == 'approved' for c in cases)} of {len(cases)} approved" if cases else "no test cases are linked to this run, so there is nothing to approve"},
        {"name": "Every case executed", "ok": bool(cases) and all(c["id"] in last for c in cases), "detail": f"{len(last)} executed"},
        {"name": "No unresolved failures", "ok": not failed or defect_n >= len(failed), "detail": f"{len(failed)} failed, {defect_n} defect(s) logged"},
        {"name": "No failed security stage", "ok": "failed" not in (sec.get("secrets"), sec.get("sast"), sec.get("dast")), "detail": f"secrets {sec.get('secrets')}, SAST {sec.get('sast')}, DAST {sec.get('dast')}"},
        {"name": "Requirements covered", "ok": (not tr) or (tr.get("missing", 0) == 0), "detail": f"{tr.get('missing', 0)} missing" if tr else "traceability not run"},
    ]
    return {"pass": all(c["ok"] for c in checks), "checks": checks}


def request_run(run_id, actor, note="", url=None):
    actor = _actor(actor)
    with db.session(url) as s:
        if s.query(Signoff).filter_by(kind="run", subject=run_id, status="pending").first():
            raise SignoffError("Sign-off is already requested for this run.")
        so = Signoff(kind="run", subject=run_id, status="pending", requested_by=actor, note=str(note)[:2000])
        s.add(so)
        s.flush()
        _event(s, so.id, "requested", actor, note)
        s.commit()
        return {**_view(s, so), "checks": run_checks(run_id, url)}


def funnel(url=None):
    with db.session(url) as s:
        c = dict(s.query(TestCase.signoff, func.count()).group_by(TestCase.signoff).all())
        r = dict(s.query(Signoff.status, func.count()).filter(Signoff.kind == "run").group_by(Signoff.status).all())
    return {"cases": {k: c.get(k, 0) for k in CASE_STATES}, "runs": {k: r.get(k, 0) for k in ("pending", "approved", "rejected")}}
