"""ClickHouse holds the AI telemetry: every model call, every DeepEval score, every stage outcome.
CLICKHOUSE_URL=http://host:8123 (+ CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, CLICKHOUSE_DB=phoenix).
Without it, rows are kept in memory for this process only and the dashboard says so: nothing is faked as stored.
The telemetry tables never hold prompt text, answers, test data or secrets: names, ids, counts, timings and scores only.
The log tables (agent_events, mcp_calls, user_actions, release_results) hold masked, short detail. training_examples is the only table with prompt and answer text,
it is written only when PHOENIX_TRAIN_CAPTURE=1, and everything in it is masked first (logmask.py).
Writes are batched (one insert per second or per 1000 rows) so a model call never waits on a log; if ClickHouse is down the batch is spooled to disk and replayed."""
import json
import os
import statistics
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

TABLES = {
    "gateway_calls": "at DateTime64(3), run String, name String, prompt String, version UInt32, model String, status String, ms UInt32, in_chars UInt32, out_chars UInt32, fell_back UInt8, hits Array(String), tool String",
    "ai_eval": "at DateTime64(3), run String, turn UInt32, metric String, score Float32, passed UInt8",
    "stage_events": "at DateTime64(3), run String, stage String, status String, ms UInt32",
    "executions": "at DateTime64(3), run String, case_id String, result String, who String, ms UInt32",
    "agent_events": "at DateTime64(3), project LowCardinality(String), run String, agent LowCardinality(String), event LowCardinality(String), status LowCardinality(String), ms UInt32, detail String",
    "mcp_calls": "at DateTime64(3), project LowCardinality(String), who String, tool LowCardinality(String), status LowCardinality(String), ms UInt32, args String",
    "user_actions": "at DateTime64(3), project LowCardinality(String), who String, action LowCardinality(String), subject String, status LowCardinality(String)",
    "release_results": "at DateTime64(3), project LowCardinality(String), run String, case_id String, verdict LowCardinality(String), flaky UInt8, seconds UInt32, failed_step String, reason String",
    "defects": "at DateTime64(3), project LowCardinality(String), run String, dkey String, found_in LowCardinality(String), severity LowCardinality(String), unit_testable UInt8, status LowCardinality(String), case_id String, source LowCardinality(String)",
    "unit_results": "at DateTime64(3), project LowCardinality(String), run String, requirement String, language LowCardinality(String), kind LowCardinality(String), test String, status LowCardinality(String), ms UInt32",
    "training_examples": "at DateTime64(3), project LowCardinality(String), source LowCardinality(String), prompt String, response String, outcome LowCardinality(String), preferred String, split LowCardinality(String)",
}
PARTITIONED = {"unit_results", "defects", "agent_events", "mcp_calls", "user_actions", "release_results", "training_examples"}  # new tables: monthly partitions, project first in the key
COLS = {t: [c.split()[0] for c in d.split(", ") if not c.startswith("Array")] for t, d in TABLES.items()}


def _cols(table):
    return [c.strip().split(" ")[0] for c in TABLES[table].split(", ")]


def _types(table):
    return {c.strip().split(" ", 1)[0]: c.strip().split(" ", 1)[1] for c in TABLES[table].split(", ")}


def _default_for(type_):
    return [] if type_.startswith("Array") else ("" if "String" in type_ else 0)


class Analytics:
    def __init__(self, env=None, client=None):
        env = env if env is not None else os.environ
        self.mem = {t: [] for t in TABLES}
        self.lock = threading.Lock()
        self.client = client
        self.error = None
        self.url = env.get("CLICKHOUSE_URL", "")
        self.buf = {t: [] for t in TABLES}
        self.batch_rows = int(env.get("PHOENIX_LOG_BATCH_ROWS", "1000"))
        self.flush_every = float(env.get("PHOENIX_LOG_FLUSH_SECONDS", "1"))
        self.spool_dir = env.get("PHOENIX_LOG_SPOOL_DIR", os.path.join(env.get("PHOENIX_DATA_DIR", "."), "log-spool"))
        self.written = 0
        self._stop = threading.Event()
        self._thread = None
        if client is None and self.url:
            try:
                import clickhouse_connect
                u = urlparse(self.url)
                db = env.get("CLICKHOUSE_DB", "phoenix")
                boot = clickhouse_connect.get_client(host=u.hostname, port=u.port or 8123, username=env.get("CLICKHOUSE_USER", "default"), password=env.get("CLICKHOUSE_PASSWORD", ""), secure=u.scheme == "https")
                boot.command(f"CREATE DATABASE IF NOT EXISTS {db}")
                self.client = clickhouse_connect.get_client(host=u.hostname, port=u.port or 8123, username=env.get("CLICKHOUSE_USER", "default"), password=env.get("CLICKHOUSE_PASSWORD", ""), database=db, secure=u.scheme == "https")
            except Exception as e:  # unreachable: say so, keep working in memory
                self.error = str(e)[:200]
                self.client = None
        if self.client is not None:
            try:
                for t, d in TABLES.items():
                    extra = f" PARTITION BY toYYYYMM(at) ORDER BY (project, at)" if t in PARTITIONED else " ORDER BY (at)"
                    self.client.command(f"CREATE TABLE IF NOT EXISTS {t} ({d}) ENGINE = MergeTree{extra}")
            except Exception as e:
                self.error = str(e)[:200]
                self.client = None

    def _ensure_flusher(self):
        if self._thread is None and self.client is not None:
            self._thread = threading.Thread(target=self._loop, daemon=True, name="phoenix-log-flush")
            self._thread.start()

    def _loop(self):
        while not self._stop.wait(self.flush_every):
            try:
                self.flush()
            except Exception as e:  # noqa: BLE001 - logging never stops the platform
                self.error = str(e)[:200]

    def close(self):
        self._stop.set()
        self.flush()

    def flush(self):
        """Write every buffered row, one insert per table. A failed insert is spooled to disk and replayed on the next good flush."""
        if self.client is None:
            return 0
        n = 0
        self._replay_spool()
        for t in list(TABLES):
            with self.lock:
                rows, self.buf[t] = self.buf[t], []
            if not rows:
                continue
            try:
                self._write(t, rows)
                n += len(rows)
            except Exception as e:  # noqa: BLE001
                self.error = str(e)[:200]
                self._spool(t, rows)
        self.written += n
        return n

    def _write(self, table, rows):
        cols, ty = _cols(table), _types(table)
        self.client.insert(table, [[r.get(c, _default_for(ty[c])) for c in cols] for r in rows], column_names=cols)

    def _spool(self, table, rows):
        try:
            os.makedirs(self.spool_dir, exist_ok=True)
            with open(os.path.join(self.spool_dir, f"{table}.jsonl"), "a", encoding="utf8") as f:
                for r in rows:
                    f.write(json.dumps({**r, "at": r["at"].isoformat()}, default=str) + "\n")
        except OSError:
            with self.lock:
                self.buf[table][:0] = rows  # nowhere to spool: keep in memory rather than lose it

    def _replay_spool(self):
        if not os.path.isdir(self.spool_dir):
            return
        for t in TABLES:
            path = os.path.join(self.spool_dir, f"{t}.jsonl")
            if not os.path.exists(path):
                continue
            try:
                rows = []
                for line in open(path, encoding="utf8"):
                    r = json.loads(line)
                    r["at"] = datetime.fromisoformat(r["at"])
                    rows.append(r)
                if rows:
                    self._write(t, rows)
                os.remove(path)
            except Exception as e:  # noqa: BLE001 - still down: leave the spool for next time
                self.error = str(e)[:200]
                return

    @property
    def backend(self):
        return "clickhouse" if self.client is not None else "memory"

    def status(self):
        return {"backend": self.backend, "note": None if self.client is not None else (f"ClickHouse not reachable: {self.error}" if self.error else "CLICKHOUSE_URL is not set: rows are kept in memory and lost on restart")}

    def insert(self, table, row):
        row = dict(row)
        row.setdefault("at", datetime.now(timezone.utc))
        if self.client is not None:
            with self.lock:
                self.buf[table].append(row)
                full = len(self.buf[table]) >= self.batch_rows
            self._ensure_flusher()
            if full:
                self.flush()
            return
        with self.lock:
            self.mem[table].append(row)
            del self.mem[table][:-20000]

    # ---- reads: ClickHouse SQL when connected, the same answers from memory otherwise
    def _rows(self, table, days):
        since = datetime.now(timezone.utc) - timedelta(days=days)
        if self.client is not None:
            r = self.client.query(f"SELECT * FROM {table} WHERE at >= %(s)s ORDER BY at DESC LIMIT 50000", parameters={"s": since})
            return [dict(zip(r.column_names, row)) for row in r.result_rows]
        with self.lock:
            return [x for x in reversed(self.mem[table]) if x["at"] >= since]

    def calls(self, n=100, run=None):
        rows = self._rows("gateway_calls", 30)
        return [r for r in rows if not run or r.get("run") == run][:n]

    def ai_summary(self, days=7):
        """Model calls: volume, success, latency (p50/p95), by model, by prompt, guardrail hits. Evals: average score per metric."""
        if self.client is not None:
            try:
                q = lambda sql: self.client.query(sql, parameters={"s": datetime.now(timezone.utc) - timedelta(days=days)})  # noqa: E731
                tot = q("SELECT count(), countIf(status='ok'), quantile(0.5)(ms), quantile(0.95)(ms), sum(fell_back) FROM gateway_calls WHERE at >= %(s)s").result_rows[0]
                bym = q("SELECT model, count(), quantile(0.95)(ms) FROM gateway_calls WHERE at >= %(s)s AND model != '' GROUP BY model ORDER BY 2 DESC").result_rows
                byp = q("SELECT prompt, count() FROM gateway_calls WHERE at >= %(s)s GROUP BY prompt ORDER BY 2 DESC LIMIT 10").result_rows
                hits = q("SELECT arrayJoin(hits) h, count() FROM gateway_calls WHERE at >= %(s)s GROUP BY h ORDER BY 2 DESC").result_rows
                day = q("SELECT toDate(at) d, count(), countIf(status='ok') FROM gateway_calls WHERE at >= %(s)s GROUP BY d ORDER BY d").result_rows
                ev = q("SELECT metric, count(), avg(score), avg(passed) FROM ai_eval WHERE at >= %(s)s GROUP BY metric").result_rows
                return {"source": "clickhouse", "calls": {"total": tot[0], "ok": tot[1], "p50": round(tot[2]), "p95": round(tot[3]), "fellBack": tot[4]},
                        "byModel": [{"model": m, "calls": c, "p95": round(p)} for m, c, p in bym], "byPrompt": [{"prompt": p, "calls": c} for p, c in byp],
                        "guardrailHits": [{"hit": h, "count": c} for h, c in hits], "perDay": [{"day": str(d), "calls": c, "ok": o} for d, c, o in day],
                        "evals": [{"metric": m, "n": n, "avg": round(float(a), 2), "passRate": round(float(p), 2)} for m, n, a, p in ev]}
            except Exception as e:
                self.error = str(e)[:200]
        rows = self._rows("gateway_calls", days)
        ms = sorted(r.get("ms", 0) for r in rows)
        pct = lambda p: ms[min(len(ms) - 1, int(len(ms) * p))] if ms else 0  # noqa: E731
        by = {}
        for r in rows:
            if r.get("model"):
                by.setdefault(r["model"], []).append(r.get("ms", 0))
        hitc, days_ = {}, {}
        for r in rows:
            for h in r.get("hits", []) or []:
                hitc[h] = hitc.get(h, 0) + 1
            d = days_.setdefault(r["at"].date().isoformat(), [0, 0])
            d[0] += 1
            d[1] += r.get("status") == "ok"
        pr = {}
        for r in rows:
            pr[r.get("prompt", "")] = pr.get(r.get("prompt", ""), 0) + 1
        ev = {}
        for r in self._rows("ai_eval", days):
            e = ev.setdefault(r["metric"], [])
            e.append(r)
        return {"source": "memory", "calls": {"total": len(rows), "ok": sum(r.get("status") == "ok" for r in rows), "p50": pct(0.5), "p95": pct(0.95), "fellBack": sum(r.get("fell_back", 0) for r in rows)},
                "byModel": [{"model": m, "calls": len(v), "p95": sorted(v)[min(len(v) - 1, int(len(v) * 0.95))]} for m, v in by.items()],
                "byPrompt": sorted(({"prompt": p, "calls": c} for p, c in pr.items()), key=lambda x: -x["calls"])[:10],
                "guardrailHits": sorted(({"hit": h, "count": c} for h, c in hitc.items()), key=lambda x: -x["count"]),
                "perDay": [{"day": d, "calls": v[0], "ok": v[1]} for d, v in sorted(days_.items())],
                "evals": [{"metric": m, "n": len(v), "avg": round(statistics.fmean(x["score"] for x in v), 2), "passRate": round(statistics.fmean(x["passed"] for x in v), 2)} for m, v in ev.items()]}


_default = None


def default():
    global _default
    if _default is None:
        _default = Analytics()
    return _default


def reset(a=None):
    global _default
    _default = a
