"""MCP registry: servers added from the UI, their tools, and which tools each prompt may use (HTTP JSON-RPC: tools/list, tools/call).
Stored in Postgres. Header values are stored but never returned by list(). Stdio servers are not supported: URLs only."""
import json
import re

from . import db
from . import http as _http


def _db(env):
    return (env or {}).get("DATABASE_URL")


def _safe_id(s):
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,39}", str(s or "")):
        raise ValueError("Server id: lowercase letters, numbers, dash.")
    return s


def add(id, url, headers=None, enabled=True, env=None):
    _safe_id(id)
    if not re.match(r"https?://", str(url or ""), re.I):
        raise ValueError("The MCP server address must start with http:// or https://.")
    db.doc_put("mcp", id, {"id": id, "url": url, "headers": headers or {}, "enabled": enabled, "tools": []}, _db(env))
    return next(s for s in list_servers(env) if s["id"] == id)


def remove(id, env=None):
    db.doc_delete("mcp", id, _db(env))


def set_enabled(id, enabled, env=None):
    s = db.doc_get("mcp", id, _db(env))
    if not s:
        raise ValueError(f'No MCP server "{id}".')
    s["enabled"] = bool(enabled)
    db.doc_put("mcp", id, s, _db(env))


def list_servers(env=None):
    return [{"id": s["id"], "url": s["url"], "enabled": s["enabled"], "headers": list((s.get("headers") or {}).keys()), "tools": s.get("tools", [])} for s in db.doc_list("mcp", _db(env))]


async def _rpc(server, method, params, fetch):
    status, text = await fetch("POST", server["url"], {"Content-Type": "application/json", "Accept": "application/json", **(server.get("headers") or {})},
                               json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))
    if status >= 400:
        raise RuntimeError(f"MCP {server['id']} {method} failed ({status}).")
    j = json.loads(text)
    if j.get("error"):
        raise RuntimeError(f"MCP {server['id']}: {str(j['error'].get('message', 'error'))[:200]}")
    return j.get("result")


async def refresh(id, env=None, fetch=_http.fetch):
    s = db.doc_get("mcp", id, _db(env))
    if not s:
        raise ValueError(f'No MCP server "{id}".')
    r = await _rpc(s, "tools/list", {}, fetch)
    s["tools"] = [{"name": t["name"], "description": str(t.get("description", ""))[:200]} for t in (r or {}).get("tools", [])]
    db.doc_put("mcp", id, s, _db(env))
    return next(x for x in list_servers(env) if x["id"] == id)


async def call_tool(ref, args, allowed=(), env=None, fetch=_http.fetch):
    """allowed: ['server/tool', ...] from the prompt's settings. Anything not listed is refused."""
    if ref not in allowed:
        raise PermissionError(f"The tool {ref} is not allowed for this prompt.")
    sid, _, tool = str(ref).partition("/")
    s = db.doc_get("mcp", sid, _db(env))
    if not s or not s["enabled"]:
        raise RuntimeError(f'MCP server "{sid}" is not available.')
    return await _rpc(s, "tools/call", {"name": tool, "arguments": args or {}}, fetch)
