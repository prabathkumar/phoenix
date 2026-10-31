"""Guardrails on what goes to a model (input) and what comes back (output).
Rule: {id, type, applies: input|output|both, action: block|redact|warn, params?}
Types: secrets | pii | injection | json | length | words. Heuristics, not guarantees. Block wins over redact over warn."""
import json
import re

SECRET_PATTERNS = [
    re.compile(r"\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}\b"), re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"), re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
    re.compile(r"(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{4,}", re.I),
]
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE = re.compile(r"(?<![\d.])\+?\d[\d\s().-]{8,14}\d(?![\d.])")
CARD = re.compile(r"\b(?:\d[ -]?){13,19}\b")
INJECTION = [re.compile(p, re.I) for p in (
    r"ignore (?:all |any |the )?(?:previous|prior|above) (?:instructions|prompts?)",
    r"disregard (?:the |your )?(?:system|previous) (?:prompt|instructions)",
    r"you are now (?:in )?(?:dan|developer mode)", r"reveal (?:your|the) (?:system )?prompt", r"</?(?:system|assistant)>")]
TYPES = {"secrets", "pii", "injection", "json", "length", "words"}


def _luhn(d):
    s, alt = 0, False
    for ch in reversed(d):
        n = int(ch)
        if alt:
            n *= 2
            if n > 9:
                n -= 9
        s += n
        alt = not alt
    return s % 10 == 0


def check(rule, text, secrets=()):
    t = str(text or "")
    found, out = [], t

    def sub(rx, label, ok=lambda m: True):
        nonlocal out

        def rep(m):
            if not ok(m.group(0)):
                return m.group(0)
            found.append(label)
            return f"[{label}]"
        out = rx.sub(rep, out)

    typ = rule.get("type")
    params = rule.get("params") or {}
    if typ == "secrets":
        for rx in SECRET_PATTERNS:
            sub(rx, "SECRET")
        for v in secrets or ():
            if v and len(str(v)) >= 4 and str(v) in out:
                out = out.replace(str(v), "[SECRET]")
                found.append("SECRET")
    elif typ == "pii":
        sub(EMAIL, "EMAIL")
        sub(CARD, "CARD", lambda m: len(re.sub(r"\D", "", m)) >= 13 and _luhn(re.sub(r"\D", "", m)))
        sub(PHONE, "PHONE", lambda m: len(re.sub(r"\D", "", m)) >= 10)
    elif typ == "injection":
        if any(rx.search(t) for rx in INJECTION):
            found.append("INJECTION")
    elif typ == "json":
        try:
            j = json.loads(re.sub(r"^```(?:json)?\s*|\s*```$", "", t))
            found += [f'missing "{k}"' for k in params.get("keys", []) if k not in (j or {})]
        except Exception:
            found.append("not JSON")
    elif typ == "length":
        if len(t) > params.get("max", 20000):
            found.append("too long")
    elif typ == "words":
        found += [f'phrase "{w}"' for w in params.get("list", []) if w and str(w).lower() in t.lower()]
    else:
        raise ValueError(f'unknown guardrail type "{typ}"')
    return found, (out if rule.get("action") == "redact" else t)


def run(rules, side, text, secrets=()):
    cur, blocked, results = str(text or ""), False, []
    for rule in rules or []:
        if rule.get("enabled") is False or rule.get("applies") not in (None, "both", side):
            continue
        found, new = check(rule, cur, secrets)
        hit = bool(found)
        if hit and rule.get("action") == "block":
            blocked = True
        if hit and rule.get("action") == "redact":
            cur = new
        results.append({"id": rule.get("id"), "type": rule.get("type"), "action": rule.get("action"), "hit": hit, "found": sorted(set(found))})
    return {"text": cur, "blocked": blocked, "results": results}


DEFAULT_RULES = [
    {"id": "no-secrets", "type": "secrets", "applies": "both", "action": "redact"},
    {"id": "no-pii", "type": "pii", "applies": "input", "action": "redact"},
    {"id": "no-injection", "type": "injection", "applies": "input", "action": "warn"},
    {"id": "max-length", "type": "length", "applies": "input", "action": "block", "params": {"max": 60000}},
]


def redact(text):
    rules = [dict(r, applies="both", action="redact") for r in DEFAULT_RULES if r["type"] in ("secrets", "pii")]
    return run(rules, "input", text)["text"]
