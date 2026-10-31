"""The AI decides, the code enforces. plan_run: the model picks stages and platforms (checked against the real stage list; invented ids dropped).
run_ai_pipeline: runs them, has the model review each stage, records stage outcomes to ClickHouse. The model can never lower a gate.
If the model is down or answers badly, every stage runs in order and the plan says so."""
import time

from . import analytics
from .pipeline import STAGES, llm_reviewer, run_pipeline

PLATFORMS = ["web", "api", "mobile"]


def fallback_plan(why):
    return {"source": "fallback", "reason": why, "platforms": list(PLATFORMS), "stages": [{"id": s["id"], "run": True, "why": "default order"} for s in STAGES]}


async def plan_run(goal, requirement="", call_json=None, past=()):
    if not call_json:
        return fallback_plan("no model configured")
    prompt = (f"You are the test manager of an automated QA platform. Plan this run.\nGoal: {goal}\nRequirement:\n{str(requirement)[:4000]}\n"
              + (("Recent runs (learn from them):\n" + "\n".join(past) + "\n") if past else "")
              + f"Stages available: {', '.join(s['id'] for s in STAGES)}.\nDecide which platforms the requirement needs (web, api, mobile; only those it mentions), and which stages to run.\n"
              + 'Reply JSON {"platforms":["web"],"stages":[{"id":"scenarios","run":true,"why":"short reason"}]}.')
    try:
        r = await call_json(prompt)
    except Exception as e:
        return fallback_plan(f"model unavailable: {e}")
    if not isinstance(r, dict) or not isinstance(r.get("stages"), list):
        return fallback_plan("the model's plan could not be read")
    known = {s["id"] for s in STAGES}
    chosen = {s["id"]: s for s in r["stages"] if isinstance(s, dict) and s.get("id") in known}
    plats = [p for p in (r.get("platforms") or []) if p in PLATFORMS]
    return {"source": "ai", "platforms": plats or list(PLATFORMS),
            "stages": [{"id": s["id"], "run": chosen[s["id"]].get("run") is not False, "why": str(chosen[s["id"]].get("why", ""))[:200]} if s["id"] in chosen
                       else {"id": s["id"], "run": True, "why": "not mentioned by the AI; default"} for s in STAGES]}


async def run_ai_pipeline(goal, requirement="", ctx=None, handlers=None, autonomy=None, approvals=None, production=False, call_json=None, run=None, run_id="", stages=None, past=()):
    known = {s["id"] for s in STAGES}
    manual = [i for i in (stages or []) if i in known] if isinstance(stages, list) else None
    if manual:
        plan = {"source": "manual", "platforms": list(PLATFORMS), "stages": [{"id": s["id"], "run": s["id"] in manual, "why": "you chose this stage" if s["id"] in manual else "not chosen"} for s in STAGES]}
    else:
        plan = await plan_run(goal, requirement, call_json, past)
    only = [s["id"] for s in plan["stages"] if s["run"]]
    kw = {"run": run} if run else {}
    result = await run_pipeline({**(ctx or {}), "platforms": plan["platforms"]}, handlers, only, ai=llm_reviewer(call_json) if call_json else None, autonomy=autonomy, approvals=approvals, production=production, **kw)
    why = {p["id"]: p["why"] for p in plan["stages"]}
    out_stages = [{**s, "decided": why.get(s["id"])} for s in result["stages"]]
    a = analytics.default()
    for s in out_stages:
        a.insert("stage_events", {"run": run_id, "stage": s["id"], "status": s["status"], "ms": int(s.get("ms", 0))})
    return {**result, "stages": out_stages, "plan": plan}
