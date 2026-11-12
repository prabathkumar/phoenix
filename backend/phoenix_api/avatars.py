"""Avatars: every tester's own. The avatar is the tester, working through agents: it carries their name, their defaults (project, app, device)
and how they like things written. Agents do the work; the work is attributed to the tester, sign-off requests go out in the tester's name
(so four eyes applies to them like any person), and nobody else can call or edit someone's avatar.

An avatar cannot lower a gate: it can make a run MORE careful than the agent asks, never less."""
import re
from datetime import datetime, timezone

from . import agents, db, guardrails

KIND = "avatar"
ORDER = ("ask-everything", "ask-when-matters", "run-everything")  # most careful first
MAX_STYLE = 1000


class AvatarError(ValueError):
    pass


def _slug(owner):
    s = re.sub(r"[^a-z0-9]+", "-", str(owner or "").strip().lower()).strip("-")
    if not s:
        raise AvatarError("Say who you are (the signed-in user).")
    return s[:60]


def _same(a, b):
    return _slug(a) == _slug(b)


def _clean_defaults(d):
    d = d if isinstance(d, dict) else {}
    out = {}
    for k in ("project", "appUrl"):
        if d.get(k):
            out[k] = str(d[k])[:300]
    if d.get("autonomy"):
        if d["autonomy"] not in ORDER:
            raise AvatarError(f"Autonomy is one of {', '.join(ORDER)}.")
        out["autonomy"] = d["autonomy"]
    for blk, keys in (("web", ("url", "runOn")), ("mobile", ("platform", "appUrl", "runOn", "device", "osVersion"))):
        b = d.get(blk)
        if isinstance(b, dict):
            out[blk] = {k: str(b[k])[:300] for k in keys if b.get(k)}
    return out


def save(owner, d, actor, url=None):
    if not _same(owner, actor):
        raise AvatarError("An avatar can only be edited by the person it belongs to.")
    style = str(d.get("style") or "").strip()[:MAX_STYLE]
    for typ, why in (("secrets", "looks like a secret or password"), ("injection", "looks like an instruction to ignore the rules")):
        if style and guardrails.check({"type": typ, "action": "warn"}, style)[0]:
            raise AvatarError(f"The style notes {why}. Credentials are test data, supplied at run time.")
    key = _slug(owner)
    cur = db.doc_get(KIND, key, url) or {}
    a = {"owner": str(owner).strip()[:120], "displayName": str(d.get("displayName") or owner)[:80], "style": style, "defaults": _clean_defaults(d.get("defaults")),
         "agents": [str(x).lower() for x in d.get("agents", [])] if isinstance(d.get("agents"), list) else [], "createdAt": cur.get("createdAt") or datetime.now(timezone.utc).isoformat(timespec="seconds")}
    db.doc_put(KIND, key, a, url)
    return a


def get(owner, url=None):
    return db.doc_get(KIND, _slug(owner), url)


def plan(owner, agent_name, inp, actor, url=None):
    """The ordered pipeline requests for one call through this avatar: the agent first, then every agent linked after it."""
    if not _same(owner, actor):
        raise AvatarError("You can only call your own avatar.")
    av = get(owner, url)
    if not av:
        raise AvatarError("Set up your avatar first (name, default project and app).")
    names, queue = [], [str(agent_name).lower()]
    while queue:
        n = queue.pop(0)
        if n in names:
            continue
        names.append(n)
        queue.extend(agents.get(n, url).get("then", []))
    if len(names) > agents.MAX_CHAIN:
        raise AvatarError(f"A chain can have at most {agents.MAX_CHAIN} agents.")
    if av["agents"]:
        out = [n for n in names if n not in av["agents"]]
        if out:
            raise AvatarError(f"Your avatar is not set up to call: {', '.join(out)}.")
    steps = []
    for n in names:
        merged = {**{k: v for k, v in av["defaults"].items() if k in ("web", "mobile")}, **(inp if isinstance(inp, dict) else {})}
        body = agents.request_for(n, merged, url)
        d = av["defaults"]
        body["project"] = body.get("project") or d.get("project", "")
        body["appUrl"] = body.get("appUrl") or d.get("appUrl")
        if d.get("autonomy") and ORDER.index(d["autonomy"]) < ORDER.index(body["autonomy"]):
            body["autonomy"] = d["autonomy"]  # more careful wins, never less
        if av["style"]:
            body["goal"] = f"{body['goal']}\n\nHow {av['displayName']} likes it done: {av['style']}"[:6000]
        body["avatar"] = _slug(owner)
        body["onBehalfOf"] = str(owner).strip()[:120]
        steps.append(body)
    return steps
