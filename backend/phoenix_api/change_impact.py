"""Change impact (no more misses): scan what changed in the code for a release and find what no test case covers, and what needs a person at run time.

scan(files, cases, call_json=None)  files = repo.changed_files(base, head) -> [{path, status, patch}]; cases = [{id, name, text}] (every test case the AI can read)
  -> {source, changes:[{path, status, tokens, covered_by:[case ids], gap, human_wait:[...]}], gaps:[...], human_wait:[...]}
  gap = a changed area (a function, a route, a file) that no test case mentions: a potential missed test case. The model, when given, also drafts the missing case.
human_waits(text)  the reasons a test step needs a person while it runs: 2FA/OTP, a file upload, a CAPTCHA, a QR code, a biometric, an approval on a phone.
Stated limits: coverage is judged from names and steps (words), not by running anything; a case that covers a change under other words is missed by the rules (the model
does better); a deleted file needs no new test. The result is advice for a person to decide, never an automatic pass."""
import json
import re

from . import unit_tests
from .sync_ask import ask

HUMAN = [
    ("2FA / one-time code", re.compile(r"\b(2fa|two[- ]factor|mfa|otp|one[- ]time (pass)?code|verification code|authenticator|sms code)\b", re.I)),
    ("file upload", re.compile(r"\b(upload|attach(ment)?s?\b|choose file|multipart|file input|drag (and|&) drop)\b", re.I)),
    ("CAPTCHA", re.compile(r"\b(captcha|recaptcha|hcaptcha|i am not a robot)\b", re.I)),
    ("QR code", re.compile(r"\b(qr[- ]?code|scan the qr)\b", re.I)),
    ("biometric", re.compile(r"\b(biometric|face id|fingerprint|touch id)\b", re.I)),
    ("approval on another device", re.compile(r"\b(approve (on|in) (the |your )?(phone|app|device)|push notification approval|confirm on (your )?phone)\b", re.I)),
]
STOP = {"this", "that", "with", "from", "have", "return", "returns", "self", "none", "true", "false", "const", "class", "function", "import", "export", "default", "string", "number", "value", "data", "item", "items", "list", "name", "test", "tests", "else", "elif", "while", "print", "args", "kwargs", "async", "await", "public", "private", "static", "void", "null", "undefined",
        # words so common in a code base that matching on them would call every change covered
        "order", "orders", "user", "users", "account", "service", "manager", "handler", "model", "models", "view", "views", "form", "page", "request", "response", "result", "results", "check", "create", "update", "delete", "apply", "base", "util", "utils", "helper", "helpers", "common", "main", "index"}
DEF = re.compile(r"^\+\s*(?:async\s+)?(?:def|function|func|fn|class|public|private|protected)?\s*(?:static\s+)?(?:[\w<>\[\]]+\s+)?(\w{4,})\s*\(", re.M)
ROUTE = re.compile(r"[\"'`](/[A-Za-z0-9_\-/{}:]{2,})[\"'`]")
PROMPT = ("You check test coverage of a code change. For each changed area say which test cases cover it (by id) or that none does. For an area with no case, draft the missing "
          'test case. Reply JSON: {"covered":[{"path":"","case_ids":[0]}],"missing":[{"path":"","why":"","case":{"name":"","steps":"","expected":""}}]}')


def human_waits(text):
    t = str(text or "")
    return [label for label, rx in HUMAN if rx.search(t)]


def _words(name):
    """apply_discount / applyDiscount -> the whole name and its parts, so 'discount' in a test case matches the function."""
    parts = [w.lower() for w in re.split(r"_+|(?<=[a-z0-9])(?=[A-Z])", name) if len(w) >= 4]
    return {name.lower(), *parts}


def _tokens(path, patch):
    stem = re.sub(r"\.[A-Za-z0-9]+$", "", path.rsplit("/", 1)[-1])
    toks = {w.lower() for w in re.split(r"[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])", stem) if len(w) >= 4 and w.lower() not in STOP}
    for m in DEF.findall(patch or ""):
        toks |= {w for w in _words(m) if w not in STOP}
    for r in ROUTE.findall(patch or ""):
        toks |= {s.lower() for s in re.split(r"[^A-Za-z0-9]+", r) if len(s) >= 4 and s.lower() not in STOP}
    return sorted(toks)[:25]


def _relevant(f):
    p = f.get("path", "")
    return f.get("status") != "removed" and not unit_tests.IS_TEST.search(p) and not unit_tests.IGNORE.search(p) and not re.search(r"\.(md|txt|lock|json|ya?ml|toml|ini|cfg|svg|png|jpg|css)$", p, re.I)


def scan(files, cases, call_json=None):
    rel = [f for f in files if _relevant(f)]
    words = {c["id"]: set(re.findall(r"[a-z0-9]{4,}", (str(c.get("name", "")) + " " + str(c.get("text", ""))).lower())) for c in cases}
    changes = []
    for f in rel:
        toks = _tokens(f["path"], f.get("patch", ""))
        hit = [cid for cid, w in words.items() if w & set(toks)]
        changes.append({"path": f["path"], "status": f.get("status"), "tokens": toks, "covered_by": hit[:20], "gap": not hit, "human_wait": human_waits(f.get("patch", "")), "suggested_case": None})
    source = "rules"
    if call_json and changes:
        try:
            out = ask(call_json, PROMPT, json.dumps({"changes": [{"path": c["path"], "added": next((f.get("patch", "") for f in rel if f["path"] == c["path"]), "")[:1500]} for c in changes[:25]],
                                                     "cases": [{"id": c["id"], "name": str(c.get("name", ""))[:80]} for c in cases[:400]]})[:24000])
            ids, by = {c["id"] for c in cases}, {c["path"]: c for c in changes}
            for x in (out or {}).get("covered", []):
                c = by.get(x.get("path"))
                if c:
                    got = [i for i in x.get("case_ids", []) if i in ids]
                    c["covered_by"], c["gap"] = got[:20], not got
            for x in (out or {}).get("missing", []):
                c = by.get(x.get("path"))
                if c and not c["covered_by"]:
                    c["gap"], c["suggested_case"] = True, {k: str(((x.get("case") or {}).get(k)) or "")[:600] for k in ("name", "steps", "expected")} | {"why": str(x.get("why") or "")[:200]}
            source = "model"
        except Exception:  # noqa: BLE001 - the rules answer stands, and says so
            pass
    gaps = [c for c in changes if c["gap"]]
    return {"source": source, "changes": changes, "gaps": gaps, "human_wait": sorted({h for c in changes for h in c["human_wait"]}),
            "summary": {"changed_files": len(files), "relevant": len(rel), "uncovered": len(gaps)}}
