"""Jira, both ways (Jira Cloud REST v3). In: requirement + linked change requests, defect status. Out: draft/dedupe/create defects, comment, transition.
Settings: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN (+ JIRA_PROJECT_KEY, JIRA_DEFECT_TYPE). The token is only used in the Authorization header.
Errors never echo the response body. Not yet called against a real Jira from here (fake fetch in tests)."""
import base64
import json
import re
from urllib.parse import quote

from . import http as _http


class Jira:
    def __init__(self, env=None, fetch=_http.fetch):
        env = env or {}
        self.base = str(env.get("JIRA_BASE_URL", "")).rstrip("/")
        self.email, self.token = env.get("JIRA_EMAIL", ""), env.get("JIRA_API_TOKEN", "")
        self.project, self.defect_type = env.get("JIRA_PROJECT_KEY", ""), env.get("JIRA_DEFECT_TYPE", "Bug")
        self.missing = [n for n, v in (("JIRA_BASE_URL", self.base), ("JIRA_EMAIL", self.email), ("JIRA_API_TOKEN", self.token)) if not v]
        self._fetch = fetch

    async def call(self, method, path, body=None):
        if self.missing:
            raise RuntimeError(f"Jira is not connected: set {', '.join(self.missing)}.")
        auth = "Basic " + base64.b64encode(f"{self.email}:{self.token}".encode()).decode()
        status, text = await self._fetch(method, self.base + path, {"Authorization": auth, "Accept": "application/json", "Content-Type": "application/json"}, json.dumps(body) if body else None)
        if status >= 400:
            raise RuntimeError(f"Jira {method} {path.split('?')[0]} failed ({status}).")
        return json.loads(text) if text else {}


def adf_to_text(node):
    if not node:
        return ""
    if isinstance(node, str):
        return node
    if node.get("type") == "text":
        return node.get("text", "")
    inner = "".join(adf_to_text(c) for c in node.get("content", []))
    return inner + "\n" if node.get("type") in ("paragraph", "heading", "listItem", "codeBlock") else inner


def adf(text):
    return {"type": "doc", "version": 1, "content": [{"type": "paragraph", "content": [{"type": "text", "text": p}]} for p in re.split(r"\n+", str(text)) if p]}


async def read_issue(j, key):
    i = await j.call("GET", f"/rest/api/3/issue/{quote(key, safe='')}?fields=summary,description,status,issuetype,issuelinks,labels")
    f = i.get("fields") or {}
    return {"key": i.get("key"), "summary": f.get("summary", ""), "description": adf_to_text(f.get("description")).strip(), "status": (f.get("status") or {}).get("name", ""),
            "type": (f.get("issuetype") or {}).get("name", ""), "labels": f.get("labels") or [],
            "linked": [k for l in f.get("issuelinks") or [] for k in [((l.get("outwardIssue") or l.get("inwardIssue") or {}).get("key"))] if k]}


async def read_requirement(j, key):
    main = await read_issue(j, key)
    links = []
    for k in main["linked"][:10]:
        try:
            links.append(await read_issue(j, k))
        except Exception:
            pass  # an unreadable link is left out, not fatal
    text = "\n\n".join(x for x in [f"{main['key']}: {main['summary']}", main["description"], *[f"Change request {l['key']} ({l['type']}): {l['summary']}\n{l['description']}" for l in links]] if x)
    return {"key": main["key"], "text": text, "linked": [l["key"] for l in links]}


DONE = re.compile(r"^(done|resolved|closed|fixed|verified)$", re.I)


async def defects_to_retest(j, keys):
    out = []
    for k in keys:
        try:
            i = await read_issue(j, k)
            if DONE.match(i["status"]):
                out.append({"key": k, "status": i["status"]})
        except Exception:
            pass
    return out


def redact(s, secrets=()):
    t = str(s or "")
    for v in secrets:
        if v and len(str(v)) >= 4:
            t = t.replace(str(v), "***")
    return t


def draft_defect(failed, requirement=None, secrets=(), project=None):
    where = (failed.get("ranOn") or {}).get("label", "")
    lines = [x for x in [f"Failed at: {failed['step']}" if failed.get("step") else "", f"Error: {failed['error']}" if failed.get("error") else "", f"Ran on: {where}" if where else "",
                         f"Requirement: {requirement}" if requirement else "", *[f"{n + 1}. {s}" for n, s in enumerate(failed.get("steps") or [])]] if x]
    marker = "testops-case-" + re.sub(r"[^A-Za-z0-9_-]", "-", str(failed.get("id") or failed.get("name") or "case"))
    summary = f"{failed['id'] + ': ' if failed.get('id') else ''}{failed.get('name') or 'Test case failed'}"
    return {"summary": redact(summary, secrets)[:240], "description": redact("\n".join(lines), secrets), "labels": ["testops", marker], "marker": marker, "project": project}


async def find_duplicate(j, draft, project=None):
    jql = f'labels = "{draft["marker"]}" AND statusCategory != Done' + (f' AND project = "{project}"' if project else "") + " ORDER BY created DESC"
    r = await j.call("GET", f"/rest/api/3/search/jql?jql={quote(jql, safe='')}&fields=summary,status&maxResults=1")
    return (r.get("issues") or [None])[0]


async def comment(j, key, text):
    return await j.call("POST", f"/rest/api/3/issue/{quote(key, safe='')}/comment", {"body": adf(text)})


async def log_defect(j, draft, project=None):
    p = project or draft.get("project") or j.project
    if not p:
        raise RuntimeError("Set JIRA_PROJECT_KEY (or pass project) to log defects.")
    dup = await find_duplicate(j, draft, p)
    if dup:
        await comment(j, dup["key"], f"Failed again.\n{draft['description']}")
        return {"commented": True, "key": dup["key"]}
    r = await j.call("POST", "/rest/api/3/issue", {"fields": {"project": {"key": p}, "summary": draft["summary"], "description": adf(draft["description"]), "issuetype": {"name": j.defect_type}, "labels": draft["labels"]}})
    return {"created": True, "key": r["key"]}


async def transition(j, key, name):
    t = await j.call("GET", f"/rest/api/3/issue/{quote(key, safe='')}/transitions")
    hit = next((x for x in t.get("transitions", []) if x["name"].lower() == str(name).lower()), None)
    if not hit:
        raise RuntimeError(f'Jira has no "{name}" move for {key}.')
    await j.call("POST", f"/rest/api/3/issue/{quote(key, safe='')}/transitions", {"transition": {"id": hit["id"]}})


def defects_handler(j, requirement=None, secrets=(), sync_type="two-way"):
    async def handler(ctx):
        failed = ctx.get("failedCases") or []
        if not failed:
            return {"ok": True, "detail": "no failed cases"}
        if j.missing:
            return {"unavailable": True, "detail": f"Jira not connected: set {', '.join(j.missing)}"}
        made = [await log_defect(j, draft_defect(f, requirement, secrets)) for f in failed]
        fixed = await defects_to_retest(j, [m["key"] for m in made]) if sync_type == "two-way" else []
        c = sum(1 for m in made if m.get("created"))
        o = sum(1 for m in made if m.get("commented"))
        return {"ok": True, "detail": f"{c} logged, {o} already open" + (f", {len(fixed)} already fixed" if sync_type == "two-way" else " (one-way)"), "data": {"defects": made, "fixed": fixed}}
    return handler
