"""AI evaluation with DeepEval: is a chatbot's / assistant's / LLM's answer good?
Metrics: answer_relevancy, faithfulness (needs retrieval_context), hallucination (needs context), toxicity, bias, contextual_relevancy, geval (your criteria).
Judge: self-hosted Ollama (DEEPEVAL_OLLAMA_MODEL, DEEPEVAL_OLLAMA_URL) or OpenAI (OPENAI_API_KEY). Secrets and personal data are redacted before anything is sent.
Runs scripts/deepeval_run.py; 'unavailable' when python, deepeval or a judge is missing. Scores are also written to ClickHouse (ai_eval)."""
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from . import analytics, guardrails

METRICS = {"answer_relevancy": [], "faithfulness": ["retrieval_context"], "hallucination": ["context"], "toxicity": [], "bias": [], "contextual_relevancy": ["retrieval_context"], "geval": []}
DEFAULT_METRICS = ["answer_relevancy", "toxicity", "bias"]
SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "deepeval_run.py"
USER = re.compile(r"^\s*(user|customer|human|client|q|question)\s*[:\-]\s*(.*)$", re.I)
BOT = re.compile(r"^\s*(bot|ai|assistant|agent|a|answer|chatbot)\s*[:\-]\s*(.*)$", re.I)


def parse_conversation(text):
    turns, cur, side = [], None, None
    for line in str(text or "").splitlines():
        m, b = USER.match(line), BOT.match(line)
        if m:
            if cur and cur.get("actual_output") is not None:
                turns.append(cur)
            cur, side = {"input": m.group(2), "actual_output": None}, "input"
        elif b and cur:
            cur["actual_output"], side = b.group(2), "actual_output"
        elif cur and side and line.strip():
            cur[side] = (cur[side] or "") + "\n" + line.strip()
    if cur and cur.get("actual_output") is not None:
        turns.append(cur)
    return [{"input": t["input"].strip(), "actual_output": str(t["actual_output"]).strip()} for t in turns if t["input"].strip() and str(t["actual_output"]).strip()]


def _clean(turns):
    r = guardrails.redact
    lst = lambda v: [r(str(x)) for x in v] if isinstance(v, list) else None  # noqa: E731
    out = []
    for t in turns:
        o = {"input": r(t["input"]), "actual_output": r(t["actual_output"])}
        if t.get("expected_output"):
            o["expected_output"] = r(t["expected_output"])
        for k in ("context", "retrieval_context"):
            if lst(t.get(k)) is not None:
                o[k] = lst(t[k])
        out.append(o)
    return out


def available(run=subprocess.run, env=None):
    env = env if env is not None else os.environ
    if run([sys.executable, "-c", "import deepeval"], capture_output=True).returncode != 0:
        return {"ok": False, "why": "DeepEval is not installed (pip install deepeval)"}
    if not env.get("DEEPEVAL_OLLAMA_MODEL") and not env.get("OPENAI_API_KEY"):
        return {"ok": False, "why": "no judge model: set DEEPEVAL_OLLAMA_MODEL (and DEEPEVAL_OLLAMA_URL), or OPENAI_API_KEY"}
    return {"ok": True}


def summarize(results, turns):
    scored = [x for x in results if isinstance(x.get("score"), (int, float))]
    by = {}
    for x in scored:
        m = by.setdefault(x["metric"], {"n": 0, "passed": 0, "sum": 0.0})
        m["n"] += 1
        m["sum"] += x["score"]
        m["passed"] += bool(x.get("passed"))
    for m in by.values():
        m["avg"] = round(m.pop("sum") / m["n"], 2)
    failed = sum(1 for x in scored if not x.get("passed"))
    return {"turns": turns, "scored": len(scored), "passed": len(scored) - failed, "failed": failed, "skipped": len(results) - len(scored), "byMetric": by}


def evaluate(turns=None, conversation=None, metrics=None, threshold=0.5, criteria=None, run=subprocess.run, env=None, script=SCRIPT, run_id=""):
    env = env if env is not None else os.environ
    allt = turns if turns else parse_conversation(conversation)
    if not allt:
        return {"status": "error", "why": "No conversation to evaluate: give turns, or text with User: and Bot: lines."}
    chosen = [m for m in (metrics or DEFAULT_METRICS) if m in METRICS]
    if not chosen:
        return {"status": "error", "why": f"Pick at least one metric: {', '.join(METRICS)}."}
    if "geval" in chosen and not str(criteria or "").strip():
        return {"status": "error", "why": "G-Eval needs your criteria in words."}
    if not 0 <= float(threshold) <= 1:
        return {"status": "error", "why": "Threshold is between 0 and 1."}
    av = available(run, env)
    if not av["ok"]:
        return {"status": "unavailable", "why": av["why"]}
    with tempfile.TemporaryDirectory(prefix="deepeval-") as d:
        fin, fout = Path(d, "in.json"), Path(d, "out.json")
        fin.write_text(json.dumps({"turns": _clean(allt), "metrics": chosen, "threshold": float(threshold), "criteria": guardrails.redact(criteria) if criteria else None}))
        r = run([sys.executable, str(script), str(fin), str(fout)], capture_output=True, text=True, env={**os.environ, **env}, timeout=900)
        last = (r.stderr or "").strip().splitlines()[-1:] or [""]
        if r.returncode == 3:
            return {"status": "unavailable", "why": last[0]}
        if r.returncode != 0:
            return {"status": "error", "why": f"DeepEval failed (exit {r.returncode}): {last[0][:200]}"}
        results = json.loads(fout.read_text())["results"]
    for x in results:
        if isinstance(x.get("score"), (int, float)):
            analytics.default().insert("ai_eval", {"run": run_id, "turn": x.get("turn", 0), "metric": x["metric"], "score": float(x["score"]), "passed": int(bool(x.get("passed")))})
    return {"status": "ok", "results": results, "summary": summarize(results, len(allt))}
