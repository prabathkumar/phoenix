"""Git hosts, one interface: GitHub and GitLab (cloud or self-hosted).
 connect(provider, project, token, base_url=None, fetch=...) -> Repo with default_branch / list_files / read_file / open_pull_request
Tokens (GITHUB_TOKEN / GITLAB_TOKEN) only go in the Authorization header. Errors name the call and status, never the body. Never writes the base branch."""
import base64
import json
import re
from urllib.parse import quote

from . import http as _http


class Repo:
    def __init__(self, provider, project, token, base_url=None, fetch=_http.fetch):
        if provider not in ("github", "gitlab"):
            raise ValueError('provider must be "github" or "gitlab".')
        if not re.fullmatch(r"[\w.-]+(/[\w.-]+)+", str(project or "")):
            raise ValueError('project looks like "owner/name".')
        if not token:
            raise ValueError(f"Set {'GITHUB_TOKEN' if provider == 'github' else 'GITLAB_TOKEN'} to connect to {provider}.")
        self.provider, self.project, self.token, self.gh, self._fetch = provider, project, token, provider == "github", fetch
        self.root = (base_url or ("https://api.github.com" if self.gh else "https://gitlab.com/api/v4")).rstrip("/")
        self.id = quote(project, safe="")

    async def _call(self, method, path, body=None):
        h = {"Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json"} if self.gh else {"PRIVATE-TOKEN": self.token}
        status, text = await self._fetch(method, self.root + path, {**h, "Content-Type": "application/json"}, json.dumps(body) if body is not None else None)
        if status >= 400:
            raise RuntimeError(f"{self.provider} {method} {path.split('?')[0]} failed ({status}).")
        return json.loads(text) if text else {}

    async def default_branch(self):
        return (await self._call("GET", f"/repos/{self.project}" if self.gh else f"/projects/{self.id}"))["default_branch"]

    async def list_files(self, ref):
        if self.gh:
            return [t["path"] for t in (await self._call("GET", f"/repos/{self.project}/git/trees/{quote(ref, safe='')}?recursive=1")).get("tree", []) if t["type"] == "blob"]
        out = []
        for page in range(1, 11):
            r = await self._call("GET", f"/projects/{self.id}/repository/tree?recursive=true&per_page=100&page={page}&ref={quote(ref, safe='')}")
            out += [t["path"] for t in r if t["type"] == "blob"]
            if len(r) < 100:
                break
        return out

    async def read_file(self, path, ref):
        if self.gh:
            r = await self._call("GET", f"/repos/{self.project}/contents/{'/'.join(quote(p, safe='') for p in path.split('/'))}?ref={quote(ref, safe='')}")
        else:
            r = await self._call("GET", f"/projects/{self.id}/repository/files/{quote(path, safe='')}?ref={quote(ref, safe='')}")
        return base64.b64decode(r.get("content", "")).decode("utf-8", "replace")

    async def open_pull_request(self, base, branch, title, files, body=""):
        if not files:
            raise ValueError("No files to commit.")
        if self.gh:
            sha = (await self._call("GET", f"/repos/{self.project}/git/ref/heads/{quote(base, safe='')}"))["object"]["sha"]
            await self._call("POST", f"/repos/{self.project}/git/refs", {"ref": f"refs/heads/{branch}", "sha": sha})
            for f in files:
                await self._call("PUT", f"/repos/{self.project}/contents/{'/'.join(quote(p, safe='') for p in f['path'].split('/'))}",
                                 {"message": f"Add AI-generated tests: {f['path']}", "content": base64.b64encode(f["content"].encode()).decode(), "branch": branch})
            pr = await self._call("POST", f"/repos/{self.project}/pulls", {"title": title, "head": branch, "base": base, "body": body})
            return {"url": pr["html_url"], "branch": branch}
        await self._call("POST", f"/projects/{self.id}/repository/branches?branch={quote(branch, safe='')}&ref={quote(base, safe='')}")
        await self._call("POST", f"/projects/{self.id}/repository/commits", {"branch": branch, "commit_message": f"Add AI-generated tests ({len(files)} file{'s' if len(files) > 1 else ''})",
                                                                         "actions": [{"action": "create", "file_path": f["path"], "content": f["content"]} for f in files]})
        mr = await self._call("POST", f"/projects/{self.id}/merge_requests", {"source_branch": branch, "target_branch": base, "title": title, "description": body})
        return {"url": mr["web_url"], "branch": branch}


def from_env(provider, project, env, base_url=None, fetch=_http.fetch):
    return Repo(provider, project, env.get("GITHUB_TOKEN") if provider == "github" else env.get("GITLAB_TOKEN"), base_url, fetch)
