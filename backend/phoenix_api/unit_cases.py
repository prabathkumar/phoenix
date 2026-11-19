"""AI-written unit tests are first created in TestOps (the case library, linked to the requirement), then pushed to Jira as test issues linked to the
requirement. Pushing is a Jira write, so it needs the same approval as defects. A test already pushed (found by its label) is not pushed twice."""
import hashlib
import re

from . import jira as J
from . import signoff


def case_id(project, path):
    return "UT-" + hashlib.sha1(f"{project}:{path}".encode()).hexdigest()[:10].upper()


async def register(tests, project, requirement, jira, push, url=None, env=None):
    """tests: [{path, language, flagged?}]. Returns [{case, path, jira?, note?}]."""
    out = []
    for t in tests[:50]:
        cid = case_id(project, t["path"])
        c = signoff.upsert_case(cid, f"Unit tests: {t['path']}", [f"Run {t['path']} ({t.get('language', '')})" + (" - covers a Semgrep finding" if t.get("flagged") else "")], project=project or "", requirement=requirement or "", who="ai", url=url)
        row = {"case": c["id"], "path": t["path"]}
        if push and jira is not None and not jira.missing and jira.project:
            marker = "testops-unit-" + re.sub(r"[^A-Za-z0-9_-]", "-", cid)
            try:
                jql = f'labels = "{marker}" AND project = "{jira.project}"'
                from urllib.parse import quote
                hit = ((await jira.call("GET", f"/rest/api/3/search/jql?jql={quote(jql, safe='')}&fields=summary&maxResults=1")).get("issues") or [None])[0]
                if hit:
                    row.update(jira=hit["key"], note="already in Jira")
                else:
                    desc = f"Unit tests written by Phoenix for {requirement or 'the release'}.\nFile: {t['path']}\nLanguage: {t.get('language', '')}\nTestOps case: {cid}"
                    made = await jira.call("POST", "/rest/api/3/issue", {"fields": {"project": {"key": jira.project}, "summary": f"Unit tests: {t['path']}"[:240], "description": J.adf(desc),
                                                                                    "issuetype": {"name": (env or {}).get("JIRA_TEST_TYPE", "Test")}, "labels": ["testops", marker]}})
                    row["jira"] = made["key"]
                    if requirement and re.fullmatch(r"[A-Z][A-Z0-9_]+-\d+", str(requirement)):
                        try:
                            await jira.call("POST", "/rest/api/3/issueLink", {"type": {"name": "Relates"}, "inwardIssue": {"key": made["key"]}, "outwardIssue": {"key": requirement}})
                        except Exception:  # noqa: BLE001  a missing link type never loses the test issue
                            row["note"] = "created, but could not link it to the requirement"
            except Exception as e:  # noqa: BLE001
                row["note"] = f"kept in TestOps, not pushed to Jira: {str(e)[:100]}"
        elif push:
            row["note"] = "kept in TestOps; Jira is not connected"
        else:
            row["note"] = "kept in TestOps; pushing to Jira needs approval"
        out.append(row)
    return out
