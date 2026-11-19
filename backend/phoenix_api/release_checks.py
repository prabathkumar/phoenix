"""Checks and balances for the outside API: what comes in, and what the agents create before it goes back out.
IN: size limits, no secrets in requirement text, targets only on the server's allowlist (PHOENIX_API_TARGETS, fail-closed), repo and test-data shape,
    approvals only from keys that may approve. OUT: secrets redacted, sizes capped, shape checked, addresses outside the allowlist flagged."""
import ipaddress
import json
import re
from urllib.parse import urlparse

from . import guardrails

MAX_BODY = 1_000_000
LIMITS = {"requirement": 60_000, "task": 4_000}
URL = re.compile(r"https?://[^\s\"'<>)\]]+", re.I)
TARGET_KEYS = ("appUrl", "baseUrl", "apiBaseUrl")


def targets(env):
    return [t.strip().lower() for t in str((env or {}).get("PHOENIX_API_TARGETS", "")).split(",") if t.strip()]


def host_ok(host, allow):
    host = (host or "").lower().strip(".")
    for p in allow:
        if p == host or (p.startswith("*.") and host.endswith(p[1:]) and host != p[2:]):
            return True
        try:
            if "/" in p and ipaddress.ip_address(host) in ipaddress.ip_network(p, strict=False):
                return True
        except ValueError:
            pass
    return False


def _secrets(text):
    found, _ = guardrails.check({"type": "secrets", "action": "warn"}, text)
    return bool(found)


def check_input(body, env):
    """Raises ValueError with a plain message; returns warnings (things allowed but worth knowing)."""
    warn = []
    if len(json.dumps(body, default=str)) > MAX_BODY:
        raise ValueError("The request is too big (over 1 MB).")
    if "production" in body:
        raise ValueError("production cannot be set through the outside API.")
    for k, mx in LIMITS.items():
        v = body.get(k)
        if v is not None and (not isinstance(v, str) or len(v) > mx):
            raise ValueError(f"{k} must be text of at most {mx} characters.")
        if isinstance(v, str) and _secrets(v):
            raise ValueError(f"{k} looks like it holds a secret or password. Credentials go in testData, never in text.")
        if isinstance(v, str) and guardrails.check({"type": "injection", "action": "warn"}, v)[0]:
            warn.append(f"{k} contains text that looks like an instruction to the AI; it is treated as data only")
    for k in ("scenarios", "cases"):
        v = body.get(k)
        if v is not None and (not isinstance(v, list) or len(v) > 200):
            raise ValueError(f"{k} must be a list of at most 200.")
    for c in body.get("cases") or []:
        if not isinstance(c, dict) or not isinstance(c.get("id"), str):
            raise ValueError("Each case in cases needs an id.")
    if body.get("defectMode") not in (None, "single", "each"):
        raise ValueError('defectMode is "single" (one bug for everything) or "each".')
    allow = targets(env)
    for k in TARGET_KEYS:
        v = body.get(k)
        if v is None:
            continue
        u = urlparse(str(v))
        if u.scheme not in ("http", "https") or not u.hostname or u.username or u.password:
            raise ValueError(f"{k} must be an http(s) address without a username or password.")
        if not allow:
            raise ValueError(f"{k} refused: no allowed targets are set on the server (PHOENIX_API_TARGETS).")
        if not host_ok(u.hostname, allow):
            raise ValueError(f"{k} refused: {u.hostname} is not on the server's list of allowed targets.")
    r = body.get("repo")
    if r is not None:
        if not isinstance(r, dict) or r.get("provider") not in ("github", "gitlab") or not re.fullmatch(r"[\w.-]+(/[\w.-]+){1,3}", str(r.get("project") or "")):
            raise ValueError('repo needs provider "github" or "gitlab" and project like "org/app".')
        for k in ("ref", "base", "head"):
            if r.get(k) is not None and not re.fullmatch(r"[\w./+-]{1,100}", str(r[k])):
                raise ValueError(f"repo.{k} is not a valid branch, tag or commit name.")
    td = body.get("testData")
    if td is not None:
        if not isinstance(td, dict) or len(td) > 50 or any(not re.fullmatch(r"[A-Za-z_][\w.-]{0,63}", str(k)) or not isinstance(v, (str, int, float, bool)) or len(str(v)) > 500 for k, v in td.items()):
            raise ValueError("testData must be up to 50 name: value pairs (names are letters, digits, _ . -; values are short text or numbers).")
    return warn


def check_output(art, env):
    """(clean artifacts, flags). Secrets are redacted, oversized output is cut, and addresses outside the allowed targets are flagged."""
    flags, allow = [], targets(env)

    def walk(v, path):
        if isinstance(v, str):
            red = guardrails.check({"type": "secrets", "action": "redact"}, v)
            if red[0]:
                flags.append(f"secret redacted in {path}")
            out = red[1]
            for m in URL.findall(out):
                h = urlparse(m).hostname
                if h and allow and not host_ok(h, allow):
                    flags.append(f"{path} mentions {h}, which is not an allowed target")
                    break
            return out[:50_000]
        if isinstance(v, list):
            return [walk(x, f"{path}[{i}]") for i, x in enumerate(v[:500])]
        if isinstance(v, dict):
            return {k: walk(x, f"{path}.{k}") for k, x in v.items()}
        return v

    clean = walk(art if isinstance(art, dict) else {}, "artifacts")
    for k in ("scenarios", "cases", "unitTests", "apiCases"):
        if k in clean and (not isinstance(clean[k], list) or any(not isinstance(x, dict) for x in clean[k])):
            flags.append(f"{k} was not in the expected shape and was dropped")
            clean.pop(k)
    return clean, list(dict.fromkeys(flags))[:50]
