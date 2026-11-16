"""One door for every log: release agents, MCP calls, user actions, release results, and (opt-in) training examples.
Everything is masked here (logmask) before it reaches ClickHouse, whoever sent it. Reads are keyed by project id."""
import os
from datetime import datetime, timedelta, timezone

from . import analytics
from .logmask import mask

KINDS = {  # kind -> (table, fields accepted, masked text fields with their limits)
    "agent_event": ("agent_events", ["project", "run", "agent", "event", "status", "ms", "detail"], {"detail": 600}),
    "mcp_call": ("mcp_calls", ["project", "who", "tool", "status", "ms", "args"], {"args": 600}),
    "user_action": ("user_actions", ["project", "who", "action", "subject", "status"], {"subject": 300}),
    "release_result": ("release_results", ["project", "run", "case_id", "verdict", "flaky", "seconds", "failed_step", "reason"], {"reason": 500, "failed_step": 200}),
    "unit_result": ("unit_results", ["project", "run", "requirement", "language", "kind", "test", "status", "ms"], {"test": 200}),
    "defect": ("defects", ["project", "run", "dkey", "found_in", "severity", "unit_testable", "status", "case_id", "source"], {}),
    "training_example": ("training_examples", ["project", "source", "prompt", "response", "outcome", "preferred", "split"], {"prompt": 6000, "response": 3000, "preferred": 3000}),
}
READ_TABLES = {"unit_results": "unit_results", "defects": "defects", "agent_events": "agent_events", "mcp_calls": "mcp_calls", "user_actions": "user_actions", "release_results": "release_results", "training_examples": "training_examples"}
INTS = {"ms", "seconds", "flaky", "unit_testable"}


def capture_enabled(env=None):
    return (env if env is not None else os.environ).get("PHOENIX_TRAIN_CAPTURE", "") in ("1", "true", "yes")


def record(kind, row, env=None, a=None):
    """Store one event. Returns True if stored, False if the kind is switched off (training capture) or unknown. Never raises."""
    spec = KINDS.get(kind) if isinstance(kind, str) else None
    if not spec or not isinstance(row, dict):
        return False
    table, fields, texts = spec
    if kind == "training_example" and not capture_enabled(env):
        return False
    out = {}
    for f in fields:
        v = row.get(f, "")
        if f in INTS:
            try:
                v = max(0, int(v or 0))
            except (TypeError, ValueError):
                v = 0
        else:
            v = mask(v, texts.get(f, 200))
        out[f] = v
    if kind == "training_example":
        out["split"] = out["split"] or ("eval" if hash_bucket(out["prompt"]) < 10 else "train")
        out["outcome"] = out["outcome"] or "unknown"
    try:
        (a or analytics.default()).insert(table, out)
        return True
    except Exception:  # noqa: BLE001 - logging never fails the caller
        return False


def hash_bucket(text):
    """Stable 0-99 bucket from the text, so the same prompt always lands in the same split (no leakage between train and eval)."""
    import hashlib
    return int(hashlib.sha256(str(text).encode("utf8")).hexdigest()[:8], 16) % 100


def read(table, project=None, n=100, days=30, filters=None, a=None):
    if table not in READ_TABLES:
        raise ValueError(f"unknown log '{table}'; choose one of {', '.join(READ_TABLES)}")
    a = a or analytics.default()
    n = max(1, min(int(n), 1000))
    since = datetime.now(timezone.utc) - timedelta(days=days)
    allowed = [c for c in analytics._cols(table) if c not in ("at", "prompt", "response", "preferred")]  # filters on short columns only
    flt = {k: v for k, v in (filters or {}).items() if k in allowed and v not in (None, "")}
    if project:
        flt["project"] = project
    flt = {k: v for k, v in flt.items() if k in analytics._cols(table)}
    if a.client is not None:
        a.flush()
        where = " AND ".join(["at >= %(since)s"] + [f"{k} = %({k})s" for k in flt])
        r = a.client.query(f"SELECT * FROM {table} WHERE {where} ORDER BY at DESC LIMIT {n}", parameters={"since": since, **flt})
        rows = [dict(zip(r.column_names, row)) for row in r.result_rows]
    else:
        with a.lock:
            rows = [x for x in reversed(a.mem[table]) if x["at"] >= since and all(x.get(k) == v for k, v in flt.items())][:n]
    return [{**x, "at": x["at"].isoformat() if hasattr(x["at"], "isoformat") else x["at"]} for x in rows]


def summary(project=None, days=7, a=None):
    """Counts the Logs page shows at the top."""
    out = {}
    for t in ("agent_events", "mcp_calls", "user_actions", "release_results"):
        out[t] = len(read(t, project, 1000, days, a=a))
    return out
