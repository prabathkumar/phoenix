"""Model access: a self-hosted Ollama instance (nothing goes to a hosted provider)."""
import json
import os
import re

import httpx


def _env(env, *names, default=""):
    for n in names:
        if env.get(n):
            return env[n]
    return default


def parse_json(text):
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", str(text).strip())
    try:
        return json.loads(t)
    except Exception:
        m = re.search(r"[\[{][\s\S]*[\]}]", t)
        if not m:
            raise ValueError("the model did not answer in JSON")
        return json.loads(m.group(0))


def ollama_call_json(env=None):
    env = env or os.environ
    host = _env(env, "TESTOPS_MOBILE_OLLAMA_HOST", "OLLAMA_HOST", "TESTOPS_OLLAMA_URL", "OLLAMA_URL", default="http://localhost:11434")
    if not host.startswith("http"):
        host = "http://" + host
    model = _env(env, "TESTOPS_MOBILE_OLLAMA_MODEL", "OLLAMA_MODEL", default="llama3")
    timeout = float(env.get("TESTOPS_MOBILE_LLM_TIMEOUT_MS", 120000)) / 1000

    async def call(prompt):
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(host.rstrip("/") + "/api/generate", json={"model": model, "prompt": prompt, "stream": False, "format": "json"})
        if r.status_code != 200:
            raise RuntimeError(f"Ollama answered {r.status_code}")
        return parse_json(r.json().get("response", ""))

    return call


def ollama_configured(env=None):
    env = env or os.environ
    return any(env.get(k) for k in ("OLLAMA_HOST", "TESTOPS_OLLAMA_URL", "OLLAMA_URL", "TESTOPS_MOBILE_OLLAMA_HOST"))
