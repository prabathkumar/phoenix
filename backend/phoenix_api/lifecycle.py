"""One requirement, followed end to end. For each requirement key the platform shows how far it has got and what is missing:
  requirement -> scenarios -> test cases -> case sign-off -> unit tests -> unit tests passing -> integration tests passing -> executed in a release -> no open defects
Unit and integration results come from the connectors (test_connectors) and carry the requirement key in the test name, so a requirement is tied to the code
that proves it. Runs repeat: every run is kept under its own run id; the LATEST run decides pass/fail, earlier runs show history and flaky tests
(a test that passed in one run and failed in another). A requirement is 'done' only when every stage is reached, nothing is open, and the latest runs are green."""
from . import db, logstore, signoff
from .db import Execution

STAGES = ["requirement", "scenarios", "cases", "caseSignoff", "unitTests", "unitPassing", "integrationPassing", "executed", "noOpenDefects"]
LABEL = {"requirement": "Requirement", "scenarios": "Scenarios", "cases": "Test cases", "caseSignoff": "Cases signed off", "unitTests": "Unit tests exist",
         "unitPassing": "Unit tests pass", "integrationPassing": "Integration tests pass", "executed": "Executed in a release", "noOpenDefects": "No open defects"}


def _latest(rows):
    """Rows of one requirement and kind -> (latest run's rows, number of runs, flaky tests)."""
    runs = {}
    for r in rows:
        runs.setdefault(r["run"] or r["at"][:10], []).append(r)
    order = sorted(runs, key=lambda k: max(x["at"] for x in runs[k]))
    status = {}
    for k in order:
        for r in runs[k]:
            status.setdefault(r["test"], set()).add(r["status"])
    flaky = sorted(t for t, s in status.items() if {"passed", "failed"} <= s)
    return (runs[order[-1]] if order else []), len(order), flaky


def build(project=None, url=None, a=None):
    cases = signoff.list_cases(project=project or None, url=url)
    unit = logstore.read("unit_results", project, 1000, 365, a=a)
    defects = logstore.read("defects", project, 1000, 365, a=a)
    with db.session(url) as s:
        ex = s.query(Execution).all()
    by_req = {}
    for c in cases:
        by_req.setdefault(c["requirement"] or "", []).append(c)
    keys = sorted({k for k in by_req if k} | {u["requirement"] for u in unit if u["requirement"]})
    out = []
    for k in keys:
        cs = by_req.get(k, [])
        ids = {c["id"] for c in cs}
        ur = [u for u in unit if u["requirement"] == k]
        u_latest, u_runs, u_flaky = _latest([u for u in ur if u["kind"] == "unit"])
        i_latest, i_runs, i_flaky = _latest([u for u in ur if u["kind"] == "integration"])
        done_ex = [e for e in ex if e.case_id in ids and e.result in ("passed", "failed")]
        dfs = [d for d in defects if d["case_id"] in ids or d["dkey"] == k]
        open_d = [d for d in dfs if d["status"] not in ("closed", "fixed")]
        reached = {
            "requirement": True,
            "scenarios": any(c["scenario"] for c in cs),
            "cases": bool(cs),
            "caseSignoff": bool(cs) and all(c["signoff"] == "approved" for c in cs),
            "unitTests": bool(u_latest),
            "unitPassing": bool(u_latest) and all(r["status"] != "failed" for r in u_latest) and any(r["status"] == "passed" for r in u_latest),
            "integrationPassing": bool(i_latest) and all(r["status"] != "failed" for r in i_latest) and any(r["status"] == "passed" for r in i_latest),
            "executed": bool(done_ex) and all(e.result == "passed" for e in done_ex[-len(ids):] if True),
            "noOpenDefects": not open_d,
        }
        missing = [LABEL[s] for s in STAGES if not reached[s]]
        out.append({"requirement": k, "reached": reached, "missing": missing, "done": not missing,
                    "cases": len(cs), "unit": {"tests": len(u_latest), "failed": sum(r["status"] == "failed" for r in u_latest), "runs": u_runs, "flaky": u_flaky[:10], "languages": sorted({r["language"] for r in u_latest})},
                    "integration": {"tests": len(i_latest), "failed": sum(r["status"] == "failed" for r in i_latest), "runs": i_runs, "flaky": i_flaky[:10], "languages": sorted({r["language"] for r in i_latest})},
                    "executions": len(done_ex), "openDefects": len(open_d)})
    unlinked = sorted({u["test"] for u in unit if not u["requirement"]})
    n = len(out)
    return {"project": project or "", "stages": [{"id": s, "label": LABEL[s]} for s in STAGES], "requirements": out,
            "summary": {"requirements": n, "done": sum(r["done"] for r in out), "coverage": {s: round(sum(r["reached"][s] for r in out) / n, 3) if n else None for s in STAGES}},
            "unlinkedTests": len(unlinked), "unlinkedSample": unlinked[:10],
            "note": None if n else "No requirement has cases or tagged tests yet. Put the requirement key (for example PROJ-123) in the test case and in each unit test's name."}
