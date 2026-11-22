"""MCP server that lets ILMU Code (or any MCP client) drive the Phoenix Release API.

Plain Python, no extra packages. It speaks MCP over stdio (one JSON message per line) and turns
each tool call into a call to the Release API (docs/RELEASE_API.md), so every check there still
applies: API key, input and output checks, target allowlist, approvals.

Settings (environment):
  PHOENIX_URL      base address of the Phoenix server, e.g. http://localhost:8000
  PHOENIX_API_KEY  the caller's key. A key without approve rights cannot approve anything,
                   so an AI caller can never approve its own live scan or Jira writes.

Run:  python -m phoenix_mcp.server
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

PROTOCOL = "2024-11-05"
DONE = ("passed", "failed", "needs-you", "interrupted")

UNIT_STEPS = [{"agent": "forge", "action": "link-repo"}, {"agent": "forge", "action": "write-unit-tests"}, {"agent": "forge", "action": "run-unit-tests"}]
SCAN_STEPS = [{"agent": "warden", "action": "scan"}]

COMMON = {
    "release": {"type": "string", "description": "Release number made by the Head of QA in TestOps. Give this or project."},
    "project": {"type": "string", "description": "TestOps project id or name (linked to Jira). Give this or release."},
    "jiraKey": {"type": "string", "description": "Jira issue of the requirement, e.g. SHP-12."},
    "requirement": {"type": "string", "description": "The requirement text, if there is no Jira id."},
    "repo": {"type": "object", "description": "{provider: github|gitlab, project: 'org/app', base: ref, head: ref}"},
    "appUrl": {"type": "string", "description": "Test target; must be on the server's allowlist."},
    "wait": {"type": "boolean", "description": "Wait for the result (up to waitSeconds) instead of returning the run id at once."},
    "waitSeconds": {"type": "integer", "description": "How long to wait, default 120."},
}


def _schema(props, required=()):
    return {"type": "object", "properties": props, "required": list(required)}


TOOLS = [
    {"name": "testops_start_release", "description": "Start the whole AI team on a release: scenarios, cases, test data, unit tests, runs, scans, defects, evidence and the release gate. Returns a run id.",
     "inputSchema": _schema({**COMMON, "task": {"type": "string", "description": "Extra instruction for the AI."}})},
    {"name": "testops_run_unit_tests", "description": "Write unit tests for the requirement against the repo, create them in TestOps, run them and push them to Jira. Needs a requirement or Jira id, and a repo.",
     "inputSchema": _schema(COMMON)},
    {"name": "testops_run_scans", "description": "Run the secrets scan and the code-quality (SAST) scan on a temporary copy of the repo.",
     "inputSchema": _schema(COMMON)},
    {"name": "testops_send_event", "description": "Advanced: send any agent and action, or your own list of steps [{agent, action}], exactly as the Release API takes them.",
     "inputSchema": _schema({**COMMON, "agent": {"type": "string"}, "action": {"type": "string"}, "steps": {"type": "array", "items": {"type": "object"}}})},
    {"name": "testops_get_status", "description": "Status of a run: queued, running, needs-you, passed, failed or interrupted, with each agent's result.",
     "inputSchema": _schema({"id": {"type": "string"}, "wait": COMMON["wait"], "waitSeconds": COMMON["waitSeconds"]}, ["id"])},
    {"name": "testops_get_evidence", "description": "What the run created: scenarios, cases, unit-test files, findings and the pull request. Secrets are redacted.",
     "inputSchema": _schema({"id": {"type": "string"}}, ["id"])},
    {"name": "testops_list_actions", "description": "The agents and the actions each can do.", "inputSchema": _schema({})},
]


class ApiError(Exception):
    pass


def http_call(method: str, path: str, body=None, env=None):
    env = os.environ if env is None else env
    base, key = (env.get("PHOENIX_URL") or "").rstrip("/"), env.get("PHOENIX_API_KEY") or ""
    if not base or not key:
        raise ApiError("Set PHOENIX_URL and PHOENIX_API_KEY for the TestOps MCP server.")
    req = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read()).get("detail", "")
        except Exception:
            detail = ""
        raise ApiError(f"{e.code}: {detail if isinstance(detail, str) else json.dumps(detail)}") from None
    except (urllib.error.URLError, OSError) as e:
        raise ApiError(f"Cannot reach Phoenix at {base}: {e}") from None


class Server:
    def __init__(self, call=http_call, sleep=time.sleep):
        self.call, self.sleep = call, sleep

    # -- tool bodies -------------------------------------------------------
    def _event(self, a: dict, base: dict) -> dict:
        body = {k: a[k] for k in ("release", "project", "jiraKey", "requirement", "repo", "appUrl", "task") if a.get(k)}
        body.update(base)
        ev = self.call("POST", "/api/v1/events", body)
        out = {"id": ev["id"], "status": ev.get("status", "queued")}
        if a.get("wait"):
            out = self._wait(ev["id"], a.get("waitSeconds"))
        return out

    def _wait(self, eid: str, seconds=None) -> dict:
        end, st = time.time() + max(1, min(int(seconds or 120), 900)), {}
        while True:
            st = self.call("GET", f"/api/v1/events/{eid}")
            if st.get("status") in DONE or time.time() >= end:
                return st
            self.sleep(2)

    def run_tool(self, name: str, a: dict):
        if name == "testops_start_release":
            return self._event(a, {"agent": "team", "action": "release"})
        if name == "testops_run_unit_tests":
            return self._event(a, {"steps": UNIT_STEPS})
        if name == "testops_run_scans":
            return self._event(a, {"steps": SCAN_STEPS})
        if name == "testops_send_event":
            base = {k: a[k] for k in ("agent", "action", "steps") if a.get(k)}
            return self._event(a, base)
        if name == "testops_get_status":
            return self._wait(a["id"], a.get("waitSeconds")) if a.get("wait") else self.call("GET", f"/api/v1/events/{a['id']}")
        if name == "testops_get_evidence":
            return self.call("GET", f"/api/v1/events/{a['id']}/artifacts")
        if name == "testops_list_actions":
            return self.call("GET", "/api/v1/actions")
        raise KeyError(name)

    # -- MCP protocol ------------------------------------------------------
    def handle(self, msg: dict):
        method, mid = msg.get("method"), msg.get("id")
        if mid is None:  # a notification: no reply
            return None
        if method == "initialize":
            return self._ok(mid, {"protocolVersion": (msg.get("params") or {}).get("protocolVersion") or PROTOCOL, "capabilities": {"tools": {}},
                                  "serverInfo": {"name": "testops-ai", "version": "1.0.0"}})
        if method == "ping":
            return self._ok(mid, {})
        if method == "tools/list":
            return self._ok(mid, {"tools": TOOLS})
        if method == "tools/call":
            p = msg.get("params") or {}
            name, args = p.get("name"), p.get("arguments") or {}
            if name not in {t["name"] for t in TOOLS}:
                return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"Unknown tool {name}"}}
            try:
                res = self.run_tool(name, args)
                return self._ok(mid, {"content": [{"type": "text", "text": json.dumps(res, indent=2)}], "isError": False})
            except (ApiError, KeyError) as e:
                return self._ok(mid, {"content": [{"type": "text", "text": f"TestOps refused or failed: {e}"}], "isError": True})
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Method not found: {method}"}}

    @staticmethod
    def _ok(mid, result):
        return {"jsonrpc": "2.0", "id": mid, "result": result}


def main(stdin=sys.stdin, stdout=sys.stdout):
    srv = Server()
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            stdout.write(json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}) + "\n")
            stdout.flush()
            continue
        out = srv.handle(msg)
        if out is not None:
            stdout.write(json.dumps(out) + "\n")
            stdout.flush()


if __name__ == "__main__":
    main()
