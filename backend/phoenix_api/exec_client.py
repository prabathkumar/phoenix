"""Calls the Node execution service (Playwright, Appium, BrowserStack) over HTTP. ENGINE_URL=http://engine:8090 ; endpoint POST /api/engine/exec."""
import json

from . import http as _http


async def execute(engine_url, body, fetch=None, timeout=1800):
    if not engine_url:
        return {"unavailable": True, "detail": "the execution engine is not configured (set ENGINE_URL)"}
    try:
        send = fetch or (lambda m, u, h, b: _http.fetch(m, u, h, b, timeout=timeout))
        status, text = await send("POST", engine_url.rstrip("/") + "/api/engine/exec", {"Content-Type": "application/json"}, json.dumps(body))
    except Exception as e:
        return {"unavailable": True, "detail": f"the execution engine is not reachable: {str(e)[:120]}"}
    if status >= 400:
        return {"unavailable": True, "detail": f"the execution engine answered {status}"}
    return json.loads(text)
