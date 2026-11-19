"""Projects and releases for the outside API. A project is linked to a Jira project; a release number is created by the Head of QA and belongs to one project.
Every event from an outside caller must name a registered release (its project comes with it) or a registered project (by id or name), so work and
unit tests are always filed against a project and its Jira project.
Who may do what (names are work addresses, comma lists in the environment; empty = nobody, fail-closed):
  PHOENIX_QA_HEADS  create, close and reopen releases; register projects.   PHOENIX_ADMINS  register projects.
The person comes from the X-User header (the platform has no real login yet: put it behind your SSO proxy)."""
import re
from datetime import datetime, timezone

from fastapi import Body, Header, HTTPException

from . import db

PROJECT, RELEASE = "project", "release-reg"
PID = re.compile(r"^[a-z0-9][a-z0-9-]{1,39}$")
JKEY = re.compile(r"^[A-Z][A-Z0-9_]{1,9}$")
REL = re.compile(r"^[\w.+\-]{1,40}$")


def _list(env, name):
    return [a.strip().lower() for a in str((env or {}).get(name, "")).split(",") if a.strip()]


def is_qa_head(env, who):
    return str(who or "").strip().lower() in _list(env, "PHOENIX_QA_HEADS")


def can_register_project(env, who):
    w = str(who or "").strip().lower()
    return w in _list(env, "PHOENIX_QA_HEADS") or w in _list(env, "PHOENIX_ADMINS")


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def find_project(ref, url=None):
    ref = str(ref or "").strip().lower()
    if not ref:
        return None
    p = db.doc_get(PROJECT, ref, url)
    return p or next((x for x in db.doc_list(PROJECT, url) if x["name"].lower() == ref), None)


def resolve(release, project, url=None):
    """-> {project, release|None, jiraKey|None} or raises LookupError (unknown), PermissionError (closed), ValueError (mismatch)."""
    rel = None
    if release:
        rel = db.doc_get(RELEASE, str(release).strip(), url)
        if not rel:
            raise LookupError(f'Release "{release}" is not registered. The Head of QA creates release numbers.')
        if rel["status"] != "open":
            raise PermissionError(f'Release "{release}" is closed. The Head of QA can reopen it.')
    if project:
        pr = find_project(project, url)
        if not pr:
            raise LookupError(f'Project "{project}" is not registered.')
        if rel and rel["project"] != pr["id"]:
            raise ValueError(f'Release "{release}" belongs to project {rel["project"]}, not {pr["id"]}.')
    elif rel:
        pr = db.doc_get(PROJECT, rel["project"], url)
    else:
        raise ValueError("Give a registered release number or a registered project (id or name).")
    return {"project": pr, "release": rel, "jiraKey": (rel or {}).get("jiraKey") or None}


def mount(app, D, audit=lambda *a: None):
    url = D.db

    def need(ok, msg):
        if not ok:
            raise HTTPException(403, msg)

    @app.get("/api/registry/projects")
    def projects():
        return {"projects": sorted(db.doc_list(PROJECT, url), key=lambda p: p["id"])}

    @app.post("/api/registry/projects")
    async def project_add(body: dict = Body(...), x_user: str = Header(default="")):
        need(can_register_project(D.env, x_user), "Only the Head of QA or an administrator can register a project (PHOENIX_QA_HEADS / PHOENIX_ADMINS).")
        pid, name, jk = str(body.get("id") or "").lower(), str(body.get("name") or "").strip(), str(body.get("jiraProjectKey") or "").upper()
        if not PID.match(pid) or not (2 <= len(name) <= 80) or not JKEY.match(jk):
            raise HTTPException(400, "Give id (letters, digits, dashes), name and jiraProjectKey (like PAY).")
        if db.doc_get(PROJECT, pid, url) or find_project(name, url):
            raise HTTPException(409, "A project with that id or name already exists.")
        verified = None
        if not D.jira.missing:  # Jira is connected: the key must be a real Jira project
            try:
                await D.jira.call("GET", f"/rest/api/3/project/{jk}")
                verified = True
            except Exception as e:  # noqa: BLE001
                raise HTTPException(422, f"Jira does not know project {jk}: {str(e)[:120]}")
        p = {"id": pid, "name": name, "jiraProjectKey": jk, "jiraVerified": verified, "createdBy": x_user, "createdAt": _now()}
        db.doc_put(PROJECT, pid, p, url)
        audit("project-registered", x_user, pid)
        return p

    @app.get("/api/registry/releases")
    def releases(project: str = ""):
        rows = [r for r in db.doc_list(RELEASE, url) if not project or r["project"] == project.lower()]
        return {"releases": sorted(rows, key=lambda r: r["createdAt"], reverse=True)}

    @app.post("/api/registry/releases")
    def release_add(body: dict = Body(...), x_user: str = Header(default="")):
        need(is_qa_head(D.env, x_user), "Only the Head of QA can create a release number (PHOENIX_QA_HEADS).")
        num, pr = str(body.get("number") or "").strip(), find_project(body.get("project"), url)
        if not REL.match(num):
            raise HTTPException(400, "Release number: up to 40 letters, digits and . _ + -")
        if not pr:
            raise HTTPException(404, "That project is not registered.")
        jk = str(body.get("jiraKey") or "").upper()
        if jk and not jk.startswith(pr["jiraProjectKey"] + "-"):
            raise HTTPException(400, f"jiraKey must be a {pr['jiraProjectKey']}-nnn issue of this project's Jira project.")
        if db.doc_get(RELEASE, num, url):
            raise HTTPException(409, "That release number already exists.")
        r = {"number": num, "project": pr["id"], "jiraKey": jk or None, "status": "open", "notes": str(body.get("notes") or "")[:300], "createdBy": x_user, "createdAt": _now()}
        db.doc_put(RELEASE, num, r, url)
        audit("release-created", x_user, num)
        return r

    @app.post("/api/registry/releases/{number}/status")
    def release_status(number: str, body: dict = Body(...), x_user: str = Header(default="")):
        need(is_qa_head(D.env, x_user), "Only the Head of QA can close or reopen a release.")
        r = db.doc_get(RELEASE, number, url)
        if not r:
            raise HTTPException(404, "No such release.")
        if body.get("status") not in ("open", "closed"):
            raise HTTPException(400, 'status is "open" or "closed".')
        r = {**r, "status": body["status"], "changedBy": x_user, "changedAt": _now()}
        db.doc_put(RELEASE, number, r, url)
        audit("release-" + body["status"], x_user, number)
        return r
