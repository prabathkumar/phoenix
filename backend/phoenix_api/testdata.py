"""Test data: make up what can be made up, ask only for what cannot (logins and records that already exist).
Placeholders in steps look like ${NAME}. Values are never stored in run records or sent to a model; only field names are."""
import json
import os
import random
import re
import string
from datetime import date, timedelta

PLACEHOLDER = re.compile(r"\$\{([A-Za-z][A-Za-z0-9_]*)\}")
EXISTING = re.compile(r"(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|OTP|LOGIN|USERNAME|USER_?ID|ACCOUNT|CUSTOMER_?ID)", re.I)
FIRST = ["Aisha", "Wei", "Ravi", "Maria", "Tom", "Nur", "Lena", "Omar"]
LAST = ["Tan", "Kumar", "Lim", "Silva", "Ng", "Hassan", "Meyer", "Lee"]


def _strings(x):
    if isinstance(x, str):
        yield x
    elif isinstance(x, dict):
        for v in x.values():
            yield from _strings(v)
    elif isinstance(x, list):
        for v in x:
            yield from _strings(v)


def required_names(steps):
    return list(dict.fromkeys(m for s in _strings(steps) for m in PLACEHOLDER.findall(s)))


def _make(name, rnd):
    n = name.upper()
    if "EMAIL" in n:
        return f"qa.{rnd.randint(1000, 9999)}@example.com"
    if "PHONE" in n or "MOBILE" in n:
        return "+65 9" + "".join(rnd.choice(string.digits) for _ in range(7))
    if "FIRST" in n:
        return rnd.choice(FIRST)
    if "LAST" in n or "SURNAME" in n:
        return rnd.choice(LAST)
    if "NAME" in n:
        return f"{rnd.choice(FIRST)} {rnd.choice(LAST)}"
    if "DATE" in n or "DOB" in n:
        return (date(1990, 1, 1) + timedelta(days=rnd.randint(0, 9000))).isoformat()
    if any(k in n for k in ("AMOUNT", "QTY", "QUANTITY", "COUNT", "NUMBER", "AGE")):
        return str(rnd.randint(1, 500))
    return "qa-" + "".join(rnd.choice(string.ascii_lowercase) for _ in range(8))


def plan_test_data(names, provided=None, seed="pipeline", env=None):
    """-> {fields:[{name, source}], values:{...}, needs_you:[names]}"""
    provided, env = provided or {}, env if env is not None else os.environ
    rnd = random.Random(seed)
    fields, values, needs = [], {}, []
    for name in names:
        if provided.get(name) not in (None, ""):
            fields.append({"name": name, "source": "you gave it"}); values[name] = provided[name]
        elif env.get(name):
            fields.append({"name": name, "source": "server setting"}); values[name] = env[name]
        elif EXISTING.search(name):
            fields.append({"name": name, "source": "needs you"}); needs.append(name)
        else:
            fields.append({"name": name, "source": "generated"}); values[name] = _make(name, rnd)
    return {"fields": fields, "values": values, "needs_you": needs}


def fill(steps_text, values):
    return PLACEHOLDER.sub(lambda m: str(values.get(m.group(1), m.group(0))), steps_text)
