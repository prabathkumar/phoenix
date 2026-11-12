"""Agents: saved AI workers. An agent is a named preset (what it is for, which pipeline stages it may use, how much it may do alone)
that runs through the SAME pipeline as everything else, so every gate, guardrail, approval and sign-off still applies.

An agent can never lower a gate: it picks stages and an autonomy level, nothing more. It cannot turn off the production gate, hold
approvals, or carry credentials. Anything created through the MCP server (an outside client) starts switched OFF and needs a person
to switch it on; that person cannot be the one who created it (four eyes, same switch as sign-off)."""
import re
from datetime import datetime, timezone

from . import db, guardrails, pipeline

KIND = "agent"
AUTONOMY = ("ask-everything", "ask-when-matters", "run-everything")
PLATFORMS = ("web", "mobile", "api")
MAX_CHAIN = 5
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,39}$")


class AgentError(ValueError):
    pass


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _actor(a):
    a = str(a or "").strip()
    if not a:
        raise AgentError("Say who you are (the signed-in user).")
    return a[:120]


def _clean(d):
    name = str(d.get("name") or "").strip().lower()
    if not NAME_RE.match(name):
        raise AgentError("Name: 2-40 characters, lowercase letters, digits and dashes, starting with a letter or digit.")
    goal = str(d.get("goal") or "").strip()
    if not goal or len(goal) > 4000:
        raise AgentError("Goal: say what this agent is for (up to 4000 characters).")
    for typ, why in (("secrets", "looks like a secret or password"), ("injection", "looks like an instruction to ignore the rules")):
        if guardrails.check({"type": typ, "action": "warn"}, goal)[0]:
            raise AgentError(f"The goal {why}. Credentials never go into an agent; they are test data, supplied at run time.")
    known = {s["id"] for s in pipeline.STAGES}
    stages = d.get("stages") if isinstance(d.get("stages"), list) else []
    bad = [s for s in stages if s not in known]
    if bad or not stages:
        raise AgentError(f"Stages: pick at least one of {', '.join(sorted(known))}." + (f" Unknown: {', '.join(map(str, bad))}." if bad else ""))
    autonomy = d.get("autonomy") or "ask-when-matters"
    if autonomy not in AUTONOMY:
        raise AgentError(f"Autonomy is one of {', '.join(AUTONOMY)}.")
    platform = d.get("platform") or "web"
    if platform not in PLATFORMS:
        raise AgentError(f"Platform is one of {', '.join(PLATFORMS)}.")
    then = [str(t).strip().lower() for t in (d.get("then") if isinstance(d.get("then"), list) else [])]
    return {"name": name, "description": str(d.get("description") or "")[:300], "goal": goal, "stages": list(dict.fromkeys(stages)), "autonomy": autonomy,
            "project": str(d.get("project") or "")[:64], "appUrl": str(d.get("appUrl") or "")[:300], "platform": platform, "then": list(dict.fromkeys(then))}


def _check_links(name, then, url):
    """Linked agents must exist and the chain must not loop or run away."""
    for t in then:
        if t == name:
            raise AgentError("An agent cannot be linked to itself.")
        if not db.doc_get(KIND, t, url):
            raise AgentError(f'Linked agent "{t}" does not exist. Build it first.')
    def walk(n, seen):
        if len(seen) > MAX_CHAIN:
            raise AgentError(f"A chain can have at most {MAX_CHAIN} agents.")
        for nxt in (then if n == name else (db.doc_get(KIND, n, url) or {}).get("then", [])):
            if nxt in seen:
                raise AgentError(f'Linking "{nxt}" here would make the chain loop back on itself.')
            walk(nxt, seen + [nxt])
    walk(name, [name])


def _public(a):
    return {k: a[k] for k in ("name", "description", "goal", "stages", "autonomy", "project", "appUrl", "platform", "then", "enabled", "source", "createdBy", "version", "history")}


def get(name, url=None):
    a = db.doc_get(KIND, str(name or "").lower(), url)
    if not a:
        raise AgentError(f'No agent called "{name}".')
    return _public(a)


def list_agents(url=None):
    return [{k: a[k] for k in ("name", "description", "stages", "autonomy", "platform", "then", "enabled", "source", "createdBy", "version")} for a in db.doc_list(KIND, url)]


def create(d, actor, source="ui", url=None):
    actor, c = _actor(actor), _clean(d)
    if db.doc_get(KIND, c["name"], url):
        raise AgentError(f'An agent called "{c["name"]}" already exists. Update it instead.')
    _check_links(c["name"], c["then"], url)
    outside = source == "mcp"  # an outside client builds it; a person switches it on
    a = {**c, "enabled": not outside, "source": source, "createdBy": actor, "version": 1,
         "history": [{"at": _now(), "actor": actor, "action": "created", "note": "created by an outside client; switched off until a person enables it" if outside else ""}]}
    db.doc_put(KIND, c["name"], a, url)
    return _public(a)


def update(name, d, actor, source="ui", url=None):
    actor = _actor(actor)
    cur = db.doc_get(KIND, str(name or "").lower(), url)
    if not cur:
        raise AgentError(f'No agent called "{name}".')
    c = _clean({**cur, **{k: v for k, v in d.items() if k != "name"}, "name": cur["name"]})
    _check_links(c["name"], c["then"], url)
    cur = {**{"platform": "web", "then": []}, **cur}
    changed = [k for k in ("goal", "stages", "autonomy", "project", "appUrl", "platform", "then") if c[k] != cur[k]]
    a = {**cur, **c, "version": cur["version"] + (1 if changed or c["description"] != cur["description"] else 0)}
    note = ""
    if changed and cur["enabled"]:
        a["enabled"], note = False, f"changed ({', '.join(changed)}); switched off until a person enables it again"
    a["history"] = cur["history"] + [{"at": _now(), "actor": actor, "action": "updated", "note": note or ", ".join(changed)}]
    db.doc_put(KIND, cur["name"], a, url)
    return _public(a)


def set_enabled(name, enabled, actor, env=None, url=None):
    actor = _actor(actor)
    cur = db.doc_get(KIND, str(name or "").lower(), url)
    if not cur:
        raise AgentError(f'No agent called "{name}".')
    if enabled and actor.lower().startswith("mcp:"):
        raise AgentError("An outside client cannot switch an agent on; a person does that in Phoenix.")
    if enabled and actor.lower() == cur["createdBy"].lower() and cur["source"] == "mcp" and str((env or {}).get("PHOENIX_ALLOW_SELF_SIGNOFF", "")).lower() != "true":
        raise AgentError("An agent built through the MCP server must be switched on by a person other than the one who created it.")
    a = {**cur, "enabled": bool(enabled), "history": cur["history"] + [{"at": _now(), "actor": actor, "action": "enabled" if enabled else "disabled", "note": ""}]}
    db.doc_put(KIND, cur["name"], a, url)
    return _public(a)


def delete(name, actor, url=None):
    _actor(actor)
    if not db.doc_get(KIND, str(name or "").lower(), url):
        raise AgentError(f'No agent called "{name}".')
    db.doc_delete(KIND, str(name).lower(), url)
    return {"deleted": str(name).lower()}


def request_for(name, inp, url=None):
    """The pipeline request for one run of this agent. The agent supplies stages and autonomy; the caller supplies the input and (only the
    caller) the production flag and approvals. Anything else in the input that could lower a gate is ignored."""
    a = get(name, url)
    if not a["enabled"]:
        raise AgentError(f'Agent "{a["name"]}" is switched off. A person has to enable it first.')
    inp = inp if isinstance(inp, dict) else {}
    allowed = ("requirement", "requirementUrl", "requirementFile", "jira", "jiraKey", "web", "mobile", "testData", "cases", "scenarios", "allowPartial", "repo", "evaluate", "ruleset", "production", "approvals", "retest")
    body = {k: inp[k] for k in allowed if k in inp}
    body["_platform"] = a["platform"]
    body.update({"goal": (a["goal"] + (f"\n\nThis run: {inp['task']}" if str(inp.get("task") or "").strip() else ""))[:6000], "stages": a["stages"], "autonomy": a["autonomy"],
                 "project": a["project"] or inp.get("project", ""), "appUrl": inp.get("appUrl") or a["appUrl"] or None, "agent": a["name"]})
    return body
