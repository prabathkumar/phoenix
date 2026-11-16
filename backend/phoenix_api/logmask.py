"""Secrets never reach a log or a training set. Mask before anything is stored: keys, tokens, passwords, card-like numbers, emails, phone numbers, Bearer headers.
Test data typed into pages is masked too when it looks like a credential."""
import re

_RULES = [
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}"), r"\1 [secret]"),
    (re.compile(r"(?i)(\"?(?:api[_-]?key|token|secret|password|passwd|pwd|authorization|x-api-key|cookie)\"?\s*[:=]\s*)(\"[^\"]*\"|'[^']*'|[^\s,;&}]+)"), r"\1[secret]"),
    (re.compile(r"\b(?:sk|pk|ghp|gho|ghs|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}\b"), "[secret]"),
    (re.compile(r"\b(?:\d[ -]?){13,19}\b"), "[number]"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[email]"),
    (re.compile(r"(?<!\w)\+?\d[\d ()-]{8,}\d(?!\w)"), "[phone]"),
]


def mask(value, limit=4000):
    text = value if isinstance(value, str) else repr(value)
    for rx, rep in _RULES:
        text = rx.sub(rep, text)
    return text[:limit]
