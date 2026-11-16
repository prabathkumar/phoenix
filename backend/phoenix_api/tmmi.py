"""An INDICATIVE TMMI (Test Maturity Model integration) view computed from what the platform actually recorded.
It is a readiness check against the TMMI process areas, not a certified assessment: TMMI Foundation assessments are done by accredited assessors on evidence
(policy documents, interviews). Here each process area is rated from data the platform holds:
  N = no evidence   P = partially (some evidence)   L = largely (clear and regular evidence)   F = fully (complete, repeated evidence)
A level is reported as achieved only when every process area of that level and below is rated L or F (the TMMI rule of thumb), and levels are never skipped.
Process areas that need paper evidence (a written test policy, an organisation chart) are rated only from platform signals and say what is missing."""

LEVELS = {
    2: ["Test Policy and Strategy", "Test Planning", "Test Monitoring and Control", "Test Design and Execution", "Test Environment"],
    3: ["Test Organization", "Test Training Program", "Test Lifecycle and Integration", "Non-Functional Testing", "Peer Reviews"],
    4: ["Test Measurement", "Product Quality Evaluation", "Advanced Reviews"],
    5: ["Defect Prevention", "Quality Control", "Test Process Optimization"],
}


def _rate(score):
    return "F" if score >= 0.85 else "L" if score >= 0.6 else "P" if score >= 0.2 else "N"


def _has(ev, agent, event=None):
    return sum(1 for x in ev if x["agent"] == agent and (event is None or x["event"] == event))


def assess(e, k, q=None):
    ev, ua, jobs, cases, fun = e["ev"], e["ua"], e["jobs"], e["cases"], e["funnel"]
    releases = k["releases"]
    signoffs_done = sum(fun["runs"].get(s, 0) for s in ("approved", "rejected")) + sum(1 for c in cases if c["signoff"] in ("approved", "rejected"))
    nf = _has(ev, "performance", "checked") + _has(ev, "security", "checked")
    triaged = _has(ev, "triage", "status")
    pa = {}

    def put(name, score, evidence, missing):
        pa[name] = {"rating": _rate(score), "score": round(score, 2), "evidence": evidence, "missing": missing}

    put("Test Policy and Strategy", 0.5 if cases and releases else 0.2 if cases or releases else 0, f"{len(cases)} test case(s) and {releases} release(s) recorded", "a written test policy and strategy document (outside the platform)")
    put("Test Planning", min(1, _has(ev, "planner", "planned") / max(1, releases)) if releases else 0, f"Planner chose cases in {_has(ev, 'planner', 'planned')} of {releases} release(s)", "risk-based planning with estimates")
    put("Test Monitoring and Control", 0.9 if k["caseRuns"] and k["releaseVerdicts"] and k["userActions"] else 0.5 if k["caseRuns"] else 0, f"{k['caseRuns']} case result(s), verdicts {k['releaseVerdicts'] or 'none'}, dashboards on logs", "defined stop/continue criteria that someone signed")
    put("Test Design and Execution", min(1, (0.5 if cases else 0) + (0.5 if k["caseRuns"] else 0)), f"{len(cases)} designed case(s), {k['caseRuns']} executed", "formal test design techniques recorded per case")
    put("Test Environment", 0.5 if releases else 0, f"{releases} release(s) ran in controlled browsers/devices", "environment requirements and readiness checks (no environment health log yet)")
    put("Test Organization", 0.4 if len({x["who"] for x in ua if x["who"]}) > 1 else 0.2 if ua else 0, f"{len({x['who'] for x in ua if x['who']})} distinct user(s) in the action log", "roles, test organisation structure (no real login/roles yet)")
    put("Test Training Program", 0.7 if any(j["status"] == "promoted" for j in jobs) else 0.4 if jobs else 0, f"{len(jobs)} model training job(s)", "training of testers (the model training program is evidenced, people training is not)")
    put("Test Lifecycle and Integration", 0.7 if releases and cases and fun else 0.3 if releases or cases else 0, "releases keyed by project, cases signed off, agents chained in the pipeline", "integration with the development lifecycle (CI trigger of releases)")
    put("Non-Functional Testing", min(1, nf / max(1, releases * 2)) if releases else 0, f"performance/security checks ran {nf} time(s) over {releases} release(s)", "load test and a scanner run inside releases (one page load and one header read today)")
    put("Peer Reviews", min(1, signoffs_done / max(1, len(cases))) if cases else 0, f"{signoffs_done} sign-off decision(s) by a person over {len(cases)} case(s)", "review of work products other than test cases")
    q = q or {}
    has_def = bool(q.get("defectsLogged"))
    put("Test Measurement", (0.5 if k["caseRuns"] else 0.2) + (0.4 if has_def and q.get("defectLeakage") is not None else 0), "KPIs and defect leakage/detection computed from logs" if has_def else "KPIs computed from logs; no defect data for leakage yet", "targets per KPI and a recorded review of the trend" + ("" if has_def else "; defect and leakage data"))
    put("Product Quality Evaluation", 0.5 if k["passRate"] is not None else 0, f"pass rate {k['passRate']}, blocked-by-site rate {k['blockedBySiteRate']}", "quality attributes and targets defined per product")
    put("Advanced Reviews", 0.3 if signoffs_done else 0, "four-eyes decisions exist", "early reviews of requirements and designs, with measured review efficiency")
    put("Defect Prevention", (0.2 if triaged else 0) + (0.3 if has_def and q.get("unitTestableDefects") is not None else 0), f"Triage explained non-passes {triaged} time(s)", "root-cause analysis and preventive actions tracked over time")
    put("Quality Control", 0.5 if k["flakyRate"] is not None and k["passRate"] is not None else 0, "statistical view of pass and flaky rates", "statistical process control limits")
    put("Test Process Optimization", 0.5 if _has(ev, "healer") and jobs else 0.3 if _has(ev, "healer") else 0, f"Healer retried failures; {len(jobs)} training job(s) feed back to the model", "a continuous improvement process with measured effect")
    out = {"levels": {}, "achieved": 1, "note": "Indicative only. A TMMI level is formally awarded by an accredited assessment; this shows where the platform's own evidence stands."}
    ok = True
    for lvl, names in LEVELS.items():
        rated = {n: pa[n] for n in names}
        passed = all(v["rating"] in ("L", "F") for v in rated.values())
        out["levels"][lvl] = {"areas": rated, "met": passed}
        if ok and passed:
            out["achieved"] = lvl
        else:
            ok = False
    out["nextSteps"] = [f"{n} (level {l}): {v['missing']}" for l, d in out["levels"].items() for n, v in d["areas"].items() if v["rating"] in ("N", "P")][:8]
    return out
