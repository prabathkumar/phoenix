"""
Example client for Phoenix's experimental semantic-action endpoint,
for whichever side of TestOps ends up calling it (TestOps' backend is
Python; its frontend is JS/React — this file is for the Python side,
since a React caller just does a plain `fetch()`, no example needed).

This talks to POST /api/semantic-action (frontend/semantic-action-
endpoint.js), which is:
  - Off by default. The Phoenix instance must be started with
    PHOENIX_ENABLE_SEMANTIC_API=1 for this endpoint to exist at all
    (see docs/PHOENIX_SPEC.md §6 and README's Act 2 section for why —
    it has never been run against real hardware yet, and dev-team
    adoption is deliberately being held until it's proven, not just
    complete).
  - Stateless from TestOps' side: it acts on whatever Phoenix recording
    session is already active (started via the normal upload flow),
    it does not start one itself.
  - Plain JSON over HTTP — nothing Node-specific. This example exists
    to save whoever wires up the real integration from re-discovering
    the request/response shape, not because a special client library is
    needed. A React caller does the equivalent with `fetch(url, {method:
    "POST", headers: {"Content-Type": "application/json"}, body:
    JSON.stringify(payload)})`.

Response shapes (see engine/semantic-act-executor.js's
SemanticActionExecutionResult for the authoritative shape):
  200 {"success": true, "selector": {...}, "diff": {...},
       "diffSummary": "...", "assertions": [...]}
  422 {"success": false, "reason": "..."}   -- action couldn't be resolved/failed
  409 {"error": "..."}                       -- no session is active
  400 {"error": "..."}                       -- malformed request
  500 {"error": "..."}                       -- unexpected server-side error

Usage:
    from testops_semantic_action_client import run_semantic_action

    result = run_semantic_action(
        "http://phoenix-host:8091",
        instruction="tap the Login button",
    )
    if result["success"]:
        print("Selector used:", result["selector"])
        print("What changed:", result.get("diffSummary"))
    else:
        print("Could not act:", result.get("reason") or result.get("error"))
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Optional


class SemanticActionError(Exception):
    """Raised for a transport-level failure (Phoenix unreachable, etc.) —
    NOT raised for an ordinary {"success": false, "reason": "..."}
    response, which is a normal, expected outcome (the instruction just
    couldn't be resolved) and is returned to the caller like any other
    result, not treated as an exception.
    """


def run_semantic_action(
    phoenix_base_url: str,
    instruction: str,
    *,
    kind: str = "tap",
    text: Optional[str] = None,
    use_visual_grounding: bool = False,
    timeout_seconds: float = 15.0,
) -> dict[str, Any]:
    """
    Runs one semantic action against whatever Phoenix recording session
    is currently active.

    :param phoenix_base_url: e.g. "http://localhost:8091" — wherever
        frontend/server.js is running with PHOENIX_ENABLE_SEMANTIC_API=1.
    :param instruction: e.g. "tap the Login button".
    :param kind: "tap" (default) or "type".
    :param text: required when kind is "type".
    :param use_visual_grounding: opt into fused text+screenshot
        resolution (see generation/semantic-snapshot.js's
        buildFusedSnapshot) — off by default, same as the Node side.
    :param timeout_seconds: request timeout; Phoenix's own Ollama call
        has its own internal timeout (PHOENIX_LLM_TIMEOUT_MS, default
        8s) plus a real device action, so this should stay generous.
    :raises SemanticActionError: on a network/transport failure only —
        not for an ordinary unresolved/failed action, which comes back
        as a normal dict with "success": False.
    """
    payload: dict[str, Any] = {"instruction": instruction, "kind": kind}
    if text is not None:
        payload["text"] = text
    if use_visual_grounding:
        payload["useVisualGrounding"] = True

    url = f"{phoenix_base_url.rstrip('/')}/api/semantic-action"
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        # 200 and 422 are both "the request was handled fine" as far as
        # HTTP is concerned — only urllib treats 422 as an HTTPError, so
        # it's caught and unwrapped the same way a 200 body would be.
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        try:
            return json.loads(err.read().decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as parse_err:
            raise SemanticActionError(
                f"Phoenix returned HTTP {err.code} with an unparseable body"
            ) from parse_err
    except urllib.error.URLError as err:
        raise SemanticActionError(f"Could not reach Phoenix at {url}: {err.reason}") from err
