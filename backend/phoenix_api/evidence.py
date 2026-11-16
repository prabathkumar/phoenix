"""Evidence of a run: reports, screenshots, HAR, logs and test data collected into ONE compressed archive, then validated, then handed to the AI as a digest.
- Text files are masked (logmask) BEFORE they go in, so the archive never holds a secret. Binary files (screenshots) go in as they are.
- Validation reopens the archive and checks: every file is in the manifest with the right SHA-256, screenshots are real PNG/JPEG files, JSON and HAR parse, no secret pattern is left.
- The AI gets a short digest (counts, failing stages, report names). Training rows are written ONLY when PHOENIX_TRAIN_CAPTURE=1, and are never labelled: a person labels them."""
import hashlib
import io
import json
import os
import re
import tarfile
import time

from . import logmask

TEXT = (".json", ".txt", ".log", ".csv", ".md", ".har", ".html", ".xml")
IMG = (".png", ".jpg", ".jpeg")
MAX_FILE = 25_000_000
MAX_FILES = 500


def _kind(name):
    n = name.lower()
    return "screenshot" if n.endswith(IMG) else "har" if n.endswith(".har") else "report" if n.endswith((".json", ".html", ".xml", ".md")) else "log" if n.endswith((".log", ".txt", ".csv")) else "other"


def _mask_json(text):
    """Mask every string inside a JSON document and keep it valid JSON (masking the raw text can cut a quote off). Keys named like secrets are masked whole."""
    SECRET_KEY = re.compile(r"(pass(word)?|secret|token|api[-_]?key|authorization|cookie)", re.I)

    def walk(v, key=""):
        if isinstance(v, dict):
            return {k: walk(x, k) for k, x in v.items()}
        if isinstance(v, list):
            return [walk(x, key) for x in v]
        if isinstance(v, str):
            return "[masked]" if SECRET_KEY.search(key) and v else logmask.mask(v, len(v) + 10)
        return v
    try:
        return json.dumps(walk(json.loads(text)), indent=1)
    except Exception:
        return None


def collect(dirs):
    out = []
    for d in dirs:
        for root, subs, files in os.walk(d, followlinks=False):
            subs[:] = [s for s in subs if not s.startswith(".")]
            for f in files:
                p = os.path.join(root, f)
                if os.path.islink(p) or not os.path.isfile(p) or os.path.getsize(p) > MAX_FILE or not f.lower().endswith(TEXT + IMG):
                    continue
                out.append((p, os.path.join(os.path.basename(os.path.abspath(d)), os.path.relpath(p, d)).replace(os.sep, "/")))
                if len(out) >= MAX_FILES:
                    return out
    return out


def bundle(run_id, dirs, out_dir, extra=None):
    """-> {path, files, rawBytes, packedBytes, ratio, manifest}. extra: {name: text} (e.g. the test data used, already masked here again)."""
    os.makedirs(out_dir, exist_ok=True)
    safe = re.sub(r"[^\w.-]", "_", str(run_id or int(time.time())))[:60]
    path = os.path.join(out_dir, f"evidence-{safe}.tar.gz")
    items, raw = [], 0
    with tarfile.open(path, "w:gz", compresslevel=9) as tar:
        def put(name, data):
            nonlocal raw
            ti = tarfile.TarInfo(name)
            ti.size, ti.mtime = len(data), int(time.time())
            tar.addfile(ti, io.BytesIO(data))
            raw += len(data)
            items.append({"name": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "kind": _kind(name)})
        for p, name in collect(dirs):
            data = open(p, "rb").read()
            if name.lower().endswith(TEXT):
                t = data.decode("utf-8", "replace")
                j = _mask_json(t) if name.lower().endswith((".json", ".har")) else None
                data = (j if j is not None else logmask.mask(t, len(t) + 10)).encode()
            put(name, data)
        for name, text in (extra or {}).items():
            put("data/" + re.sub(r"[^\w.-]", "_", name)[:80], logmask.mask(str(text), 200000).encode())
        man = json.dumps({"run": str(run_id), "createdAt": int(time.time()), "files": items}, indent=1).encode()
        ti = tarfile.TarInfo("manifest.json")
        ti.size, ti.mtime = len(man), int(time.time())
        tar.addfile(ti, io.BytesIO(man))
    packed = os.path.getsize(path)
    return {"path": path, "files": len(items), "rawBytes": raw, "packedBytes": packed, "ratio": round(packed / raw, 3) if raw else None, "manifest": items}


def _image_ok(name, data):
    if name.lower().endswith(".png"):
        return data[:8] == b"\x89PNG\r\n\x1a\n" and data[-12:-8] == b"\x00\x00\x00\x00" and data[-8:-4] == b"IEND"
    return data[:3] == b"\xff\xd8\xff" and data[-2:] == b"\xff\xd9"


def validate(path):
    """Reopen the archive and check it. Returns {ok, problems[], files, screenshots}. Never extracts to disk."""
    problems, shots = [], 0
    try:
        with tarfile.open(path, "r:gz") as tar:
            members = {m.name: m for m in tar.getmembers() if m.isfile()}
            if any(n.startswith("/") or ".." in n.split("/") for n in members):
                return {"ok": False, "problems": ["the archive has an unsafe file name"], "files": 0, "screenshots": 0}
            if "manifest.json" not in members:
                return {"ok": False, "problems": ["manifest.json is missing"], "files": len(members), "screenshots": 0}
            man = json.loads(tar.extractfile(members["manifest.json"]).read())
            listed = {f["name"]: f for f in man.get("files", [])}
            for n in members:
                if n != "manifest.json" and n not in listed:
                    problems.append(f"{n} is not in the manifest")
            for n, f in listed.items():
                if n not in members:
                    problems.append(f"{n} is listed but missing")
                    continue
                data = tar.extractfile(members[n]).read()
                if hashlib.sha256(data).hexdigest() != f["sha256"]:
                    problems.append(f"{n} is damaged (checksum differs)")
                    continue
                low = n.lower()
                if low.endswith(IMG):
                    shots += 1
                    if len(data) < 100 or not _image_ok(n, data):
                        problems.append(f"{n} is not a complete image")
                elif low.endswith(TEXT):
                    text = data.decode("utf-8", "replace")
                    if low.endswith((".json", ".har")):
                        try:
                            j = json.loads(text)
                            if low.endswith(".har") and not isinstance((j.get("log") or {}).get("entries"), list):
                                problems.append(f"{n} has no HAR entries")
                        except Exception:
                            problems.append(f"{n} is not valid JSON")
                    if low.endswith((".json", ".har")):
                        masked = _mask_json(text)
                        leaked = masked is not None and masked != json.dumps(json.loads(text), indent=1)
                    else:
                        leaked = logmask.mask(text, len(text) + 10) != text
                    if leaked:
                        problems.append(f"{n} still holds something that looks like a secret")
            return {"ok": not problems, "problems": problems[:20], "files": len(listed), "screenshots": shots}
    except Exception as e:  # a corrupt archive is a failed validation, not a crash
        return {"ok": False, "problems": [f"cannot open the archive: {str(e)[:120]}"], "files": 0, "screenshots": 0}


def digest(manifest, stages, goal=""):
    """What the AI is shown to understand the run: counts and outcomes, never file contents."""
    kinds = {}
    for f in manifest:
        kinds[f["kind"]] = kinds.get(f["kind"], 0) + 1
    return {"goal": str(goal)[:200], "files": kinds, "stages": [{"id": s["id"], "status": s["status"], "detail": str(s.get("detail") or "")[:160]} for s in stages],
            "failed": [s["id"] for s in stages if s["status"] == "failed"]}


def feed(project, run_id, dig, env=None):
    """The AI reads the digest through the log store. A training example is added only when capture is on, and it stays unlabelled for a person to judge."""
    from . import logstore
    logstore.record("agent_event", {"project": project, "run": run_id, "agent": "evidence", "event": "digest", "status": "failed" if dig["failed"] else "ok", "ms": 0, "detail": json.dumps(dig)[:300]}, env)
    if logstore.capture_enabled(env):
        logstore.record("training_example", {"project": project, "source": "run-evidence", "prompt": "Run digest:\n" + json.dumps({k: dig[k] for k in ("goal", "files", "stages")})[:3500], "response": "", "outcome": "unknown"}, env)
        return True
    return False
