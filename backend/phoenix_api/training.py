"""Training the 8B model, with people deciding.
  capture  -> training_examples (opt-in PHOENIX_TRAIN_CAPTURE=1, masked)           [logstore]
  export   -> a JSONL dataset: only good or corrected examples, de-duplicated, fixed train/eval split, preference pairs for corrections
  train    -> scripts/train/qlora_train.py (QLoRA on Qwen3-8B), started here or on a GPU box, reports back metrics
  gate     -> the tuned model must beat the live one on the held-out eval set, and not fall below a floor
  promote  -> a named person approves with a note; only then does the live model setting change. The AI never promotes itself.
Jobs are kept in $PHOENIX_DATA_DIR/training/jobs.json (few, small, human-readable)."""
import json
import os
import shlex
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone

from . import analytics, logstore

LOCK = threading.Lock()
GOOD = {"good", "passed", "approved", "corrected", "verified"}


def data_dir(env=None):
    d = os.path.join((env if env is not None else os.environ).get("PHOENIX_DATA_DIR", "."), "training")
    os.makedirs(d, exist_ok=True)
    return d


def _jobs_path(env=None):
    return os.path.join(data_dir(env), "jobs.json")


def _load(env=None):
    try:
        return json.load(open(_jobs_path(env), encoding="utf8"))
    except (OSError, ValueError):
        return {"jobs": [], "live": {"model": (env or os.environ).get("PHOENIX_AGENT_MODEL", "qwen3-8b"), "adapter": "", "since": None}}


def _save(d, env=None):
    tmp = _jobs_path(env) + ".tmp"
    json.dump(d, open(tmp, "w", encoding="utf8"), indent=1)
    os.replace(tmp, _jobs_path(env))


def rows(project=None, a=None):
    return logstore.read("training_examples", project, 1000, 3650, a=a) if (a or analytics.default()).client is not None else [
        {**x, "at": x["at"].isoformat()} for x in (a or analytics.default()).mem["training_examples"] if not project or x.get("project") == project]


def stats(project=None, env=None, a=None):
    rs = rows(project, a)
    by = {}
    for r in rs:
        k = by.setdefault(r["outcome"], 0)
        by[r["outcome"]] = k + 1
    latest = {}
    for r in sorted(rs, key=lambda x: x["at"]):
        latest[r["prompt"]] = r
    rs = list(latest.values())
    by = {}
    for r in rs:
        by[r["outcome"]] = by.get(r["outcome"], 0) + 1
    usable = [r for r in rs if r["outcome"] in GOOD]
    return {"capture": logstore.capture_enabled(env), "total": len(rs), "byOutcome": by, "usable": len(usable),
            "train": sum(r["split"] == "train" for r in usable), "eval": sum(r["split"] == "eval" for r in usable),
            "minToTrain": int((env or os.environ).get("PHOENIX_TRAIN_MIN_EXAMPLES", "200"))}


def export(project=None, env=None, a=None, out_path=None):
    """Write train.jsonl, eval.jsonl, prefs.jsonl. Chat format ({"messages":[...]}) that the trainer reads directly."""
    latest = {}
    for r in sorted(rows(project, a), key=lambda x: x["at"]):  # the newest row per prompt is its label: a person's label overrides the capture
        latest[r["prompt"]] = r
    rs = [r for r in latest.values() if r["outcome"] in GOOD and r["prompt"] and (r["response"] or r["preferred"])]
    seen, train, ev, prefs = set(), [], [], []
    for r in sorted(rs, key=lambda x: x["at"]):
        answer = r["preferred"] or r["response"]  # a human correction wins over what the model said
        key = (r["prompt"], answer)
        if key in seen:
            continue
        seen.add(key)
        item = {"messages": [{"role": "user", "content": r["prompt"]}, {"role": "assistant", "content": answer}], "source": r["source"], "project": r["project"]}
        (ev if r["split"] == "eval" else train).append(item)
        if r["preferred"] and r["response"] and r["preferred"] != r["response"]:
            prefs.append({"prompt": r["prompt"], "chosen": r["preferred"], "rejected": r["response"]})
    d = out_path or os.path.join(data_dir(env), f"dataset-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}")
    os.makedirs(d, exist_ok=True)
    for name, items in (("train", train), ("eval", ev), ("prefs", prefs)):
        with open(os.path.join(d, f"{name}.jsonl"), "w", encoding="utf8") as f:
            for it in items:
                f.write(json.dumps(it, ensure_ascii=False) + "\n")
    return {"dir": d, "train": len(train), "eval": len(ev), "prefs": len(prefs), "skipped": len(rs) - len(train) - len(ev)}


def list_jobs(env=None):
    d = _load(env)
    return {"jobs": list(reversed(d["jobs"])), "live": d["live"]}


def start(project=None, who="", base="Qwen/Qwen3-8B", epochs=2, env=None, a=None, launch=True):
    env = env if env is not None else os.environ
    st = stats(project, env, a)
    if st["train"] < st["minToTrain"]:
        raise ValueError(f"Only {st['train']} usable training examples; at least {st['minToTrain']} are needed (set PHOENIX_TRAIN_MIN_EXAMPLES to change). Capture needs PHOENIX_TRAIN_CAPTURE=1.")
    if not st["eval"]:
        raise ValueError("There is no held-out evaluation set yet; more examples are needed before a model can be judged.")
    ds = export(project, env, a)
    job_id = "tj-" + uuid.uuid4().hex[:8]
    out = os.path.join(data_dir(env), job_id)
    os.makedirs(out, exist_ok=True)
    cmd = ["python3", "scripts/train/qlora_train.py", "--data", ds["dir"], "--out", out, "--base", base, "--epochs", str(epochs), "--job", job_id,
           "--report", env.get("PHOENIX_API_SELF_URL", "http://127.0.0.1:8000") + f"/api/training/jobs/{job_id}/result"]
    job = {"id": job_id, "project": project or "", "by": who or "unknown", "at": datetime.now(timezone.utc).isoformat(), "status": "queued", "base": base, "epochs": epochs,
           "dataset": ds, "out": out, "command": " ".join(shlex.quote(c) for c in cmd), "metrics": None, "gate": None, "promoted": None}
    with LOCK:
        d = _load(env)
        d["jobs"].append(job)
        _save(d, env)
    if launch and env.get("PHOENIX_TRAIN_LAUNCH", "") in ("1", "true", "yes"):
        try:
            proc = subprocess.Popen(cmd, stdout=open(os.path.join(out, "train.log"), "w"), stderr=subprocess.STDOUT, env={**os.environ, **env})
            _update(job_id, env, status="running", pid=proc.pid)
        except OSError as e:
            _update(job_id, env, status="failed", error=str(e)[:200])
    else:
        _update(job_id, env, note="Not launched here: run the command on the GPU box (or set PHOENIX_TRAIN_LAUNCH=1 where a GPU and the training packages exist).")
    return get(job_id, env)


def _update(job_id, env=None, **fields):
    with LOCK:
        d = _load(env)
        for j in d["jobs"]:
            if j["id"] == job_id:
                j.update(fields)
                _save(d, env)
                return j
    raise ValueError(f"No such training job {job_id}.")


def get(job_id, env=None):
    for j in _load(env)["jobs"]:
        if j["id"] == job_id:
            return j
    raise ValueError(f"No such training job {job_id}.")


def gate(metrics, min_score=0.6, min_gain=0.02):
    """The tuned model passes only if it beats the live model on the held-out set by min_gain, is above a floor, and does not break answers (valid-format rate)."""
    tuned, live = float(metrics.get("tuned_score", 0)), float(metrics.get("live_score", 0))
    valid = float(metrics.get("tuned_valid", 1))
    reasons = []
    if tuned < min_score:
        reasons.append(f"tuned score {tuned:.2f} is below the floor {min_score:.2f}")
    if tuned < live + min_gain:
        reasons.append(f"tuned {tuned:.2f} does not beat the live model {live:.2f} by {min_gain:.2f}")
    if valid < 0.95:
        reasons.append(f"only {valid:.0%} of tuned answers are well formed (need 95%)")
    return {"passed": not reasons, "reasons": reasons, "tuned": tuned, "live": live}


def report(job_id, body, env=None):
    """Called by the training script: progress and, at the end, eval metrics. The gate decides; nobody else."""
    fields = {}
    if body.get("status") in ("running", "evaluating", "failed", "finished"):
        fields["status"] = body["status"]
    if "progress" in body:
        fields["progress"] = body["progress"]
    if "loss" in body:
        fields["loss"] = body["loss"]
    if body.get("metrics"):
        fields["metrics"] = body["metrics"]
        fields["gate"] = gate(body["metrics"])
        fields["status"] = "ready-for-review" if fields["gate"]["passed"] else "rejected-by-gate"
    if body.get("error"):
        fields["error"] = str(body["error"])[:300]
    return _update(job_id, env, **fields)


def promote(job_id, who, note, env=None):
    """A person approves a job that passed the gate. This records the decision and the new live adapter; serving the adapter is a deploy step."""
    if not who or who == "unknown":
        raise ValueError("Promotion needs a signed-in person.")
    if len(str(note or "").strip()) < 10:
        raise ValueError("Write why you are promoting this model (at least 10 characters).")
    j = get(job_id, env)
    if not j.get("gate") or not j["gate"]["passed"]:
        raise ValueError("This model did not pass the evaluation gate, so it cannot be promoted.")
    if j.get("by") == who and (env or os.environ).get("PHOENIX_TRAIN_FOUR_EYES", "1") != "0":
        raise ValueError("The person who started the training cannot also approve it (four eyes).")
    with LOCK:
        d = _load(env)
        d["live"] = {"model": j["base"], "adapter": os.path.join(j["out"], "adapter"), "job": job_id, "since": datetime.now(timezone.utc).isoformat(), "by": who}
        _save(d, env)
    return _update(job_id, env, status="promoted", promoted={"by": who, "note": str(note)[:500], "at": datetime.now(timezone.utc).isoformat()})
