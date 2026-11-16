"""Measuring the framework itself, from its own logs: quality KPIs and an indicative TMMI view.
Everything is computed from stored data (release_results, agent_events, user_actions, mcp_calls, executions, sign-offs, training jobs).
Nothing is estimated: a KPI with no data says so (None), and TMMI marks a process area 'N' (no evidence) rather than guessing."""
from datetime import datetime, timedelta, timezone

from . import analytics, db, logstore, signoff, training
from .db import Execution


def _ratio(a, b):
    return round(a / b, 3) if b else None


def _pct(sorted_vals, p):
    return sorted_vals[min(len(sorted_vals) - 1, int(len(sorted_vals) * p))] if sorted_vals else None


def collect(project=None, days=30, url=None, env=None, a=None):
    """Raw evidence, one place. Reads at most 1000 rows per log (the newest)."""
    rr = logstore.read("release_results", project, 1000, days, a=a)
    ev = logstore.read("agent_events", project, 1000, days, a=a)
    ua = logstore.read("user_actions", project, 1000, days, a=a)
    mc = logstore.read("mcp_calls", project, 1000, days, a=a)
    df = logstore.read("defects", project, 1000, days, a=a)
    since = datetime.now(timezone.utc) - timedelta(days=days)
    with db.session(url) as s:
        ex = [e for e in s.query(Execution).filter(Execution.at >= since).all()]
    cases = signoff.list_cases(project=project or None, url=url)
    fun = signoff.funnel(url)
    jobs = training.list_jobs(env)["jobs"]
    return {"df": df, "rr": rr, "ev": ev, "ua": ua, "mc": mc, "ex": ex, "cases": cases, "funnel": fun, "jobs": jobs, "days": days}


def kpis(e):
    rr, ev = e["rr"], e["ev"]
    ran = [r for r in rr if r["verdict"] in ("passed", "failed")]
    passed = sum(r["verdict"] == "passed" for r in ran)
    flaky = sum(1 for r in rr if r["flaky"])
    blocked = sum(r["verdict"] == "blocked-by-site" for r in rr)
    secs = sorted(r["seconds"] for r in rr if r["seconds"])
    verdicts = [x["status"] for x in ev if x["agent"] == "reporter" and x["event"] == "verdict"]
    releases = len({r["run"] for r in rr if r["run"]})
    healed = [x for x in ev if x["agent"] == "healer" and x["event"] == "flaky-passed-on-retry"]
    model_calls = [x for x in ev if x["event"] in ("model-call", "model-decision")]
    mcp_err = sum(m["status"] == "error" for m in e["mc"])
    exr = [x for x in e["ex"] if x.result in ("passed", "failed")]
    cases = e["cases"]
    approved = sum(c["signoff"] == "approved" for c in cases)
    return {
        "days": e["days"],
        "releases": releases,
        "caseRuns": len(rr),
        "passRate": _ratio(passed, len(ran)),
        "flakyRate": _ratio(flaky, len(rr)),
        "blockedBySiteRate": _ratio(blocked, len(rr)),
        "releasePassRate": _ratio(sum(v == "PASS" for v in verdicts), len(verdicts)),
        "releaseVerdicts": {v: verdicts.count(v) for v in sorted(set(verdicts))},
        "caseSecondsP50": _pct(secs, 0.5), "caseSecondsP95": _pct(secs, 0.95),
        "autoHealRate": _ratio(len(healed), sum(1 for r in rr if r["verdict"] == "failed" or r["flaky"])),
        "executionPassRate": _ratio(sum(x.result == "passed" for x in exr), len(exr)),
        "casesTotal": len(cases), "casesApproved": approved, "caseApprovalRate": _ratio(approved, len(cases)),
        "modelCalls": len(model_calls), "modelCallFailRate": _ratio(sum(x["status"] == "failed" for x in model_calls), len(model_calls)),
        "mcpCalls": len(e["mc"]), "mcpErrorRate": _ratio(mcp_err, len(e["mc"])),
        "userActions": len(e["ua"]),
        "agentsActive": sorted({x["agent"] for x in ev if x["agent"]}),
    }


PHASES = ["unit", "integration", "system", "uat", "production"]


def quality(e):
    """The measures a test organisation reports (TMMI Test Measurement): where defects are found and how many leak past each phase.
    A defect is counted once (by key, else by row). Numbers are None when there is no defect data: no defects logged is not the same as no defects."""
    seen, rows = set(), []
    for d in e["df"]:
        k = d["dkey"] or id(d)
        if k in seen:
            continue
        seen.add(k)
        rows.append(d)
    by = {p: sum(1 for d in rows if d["found_in"] == p) for p in PHASES}
    total = len(rows)
    leaks = {}
    for i, p in enumerate(PHASES[:-1]):  # leakage of phase p: defects found after p / (found in p + found after p)
        later = sum(by[q] for q in PHASES[i + 1:])
        leaks[p] = _ratio(later, by[p] + later)
    pre = sum(by[p] for p in PHASES[:-1])
    unit_testable = [d for d in rows if d["unit_testable"]]
    unit_escaped = sum(1 for d in unit_testable if d["found_in"] != "unit")
    runs = len(e["rr"])
    sev = {}
    for d in rows:
        sev[d["severity"] or "unrated"] = sev.get(d["severity"] or "unrated", 0) + 1
    return {
        "defectsLogged": total, "byPhase": by,
        "defectLeakage": _ratio(by["production"], total),                      # reached production / all defects
        "defectDetectionPercentage": _ratio(pre, total),                        # DDP: found before production / all
        "phaseLeakage": leaks,                                                  # per phase: share of its defects that got past it
        "unitTestLeakage": _ratio(unit_escaped, len(unit_testable)),            # unit-testable defects found after the unit phase
        "unitTestableDefects": len(unit_testable),
        "testCaseEffectiveness": _ratio(by["system"], runs),                    # defects found per case run in release testing
        "openDefects": sum(1 for d in rows if d["status"] not in ("closed", "fixed")),
        "severityMix": sev,
        "note": None if total else "No defects have been logged yet, so leakage and detection cannot be calculated. Pipeline runs log the defects they raise; production and unit-level defects are recorded with POST /api/defects.",
    }


def trend(rr):
    """Pass rate and flaky count per day (for the dashboard line)."""
    by = {}
    for r in rr:
        d = by.setdefault(r["at"][:10], {"ran": 0, "passed": 0, "flaky": 0})
        if r["verdict"] in ("passed", "failed"):
            d["ran"] += 1
            d["passed"] += r["verdict"] == "passed"
        d["flaky"] += 1 if r["flaky"] else 0
    return [{"day": k, "passRate": _ratio(v["passed"], v["ran"]), "flaky": v["flaky"], "ran": v["ran"]} for k, v in sorted(by.items())]


def slowest(rr, n=5):
    return sorted(({"case": r["case_id"], "seconds": r["seconds"], "verdict": r["verdict"]} for r in rr), key=lambda x: -x["seconds"])[:n]


def flaky_cases(rr, n=5):
    c = {}
    for r in rr:
        if r["flaky"]:
            c[r["case_id"]] = c.get(r["case_id"], 0) + 1
    return sorted(({"case": k, "times": v} for k, v in c.items()), key=lambda x: -x["times"])[:n]


def report(project=None, days=30, url=None, env=None, a=None):
    from . import tmmi
    e = collect(project, days, url, env, a)
    k = kpis(e)
    return {"project": project or "", "kpis": k, "quality": quality(e), "trend": trend(e["rr"]), "slowest": slowest(e["rr"]), "flakyCases": flaky_cases(e["rr"]),
            "tmmi": tmmi.assess(e, k, quality(e)), "dataSource": analytics.default().backend if a is None else a.backend}
