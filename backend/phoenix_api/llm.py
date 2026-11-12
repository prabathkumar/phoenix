"""Model access: a self-hosted model, never a hosted provider. Two kinds are understood:
  - an OpenAI-compatible server such as llama.cpp's llama-server (the GPU server): LLM_BASE_URL (+ LLM_MODEL, LLM_API_KEY)
  - Ollama: OLLAMA_HOST (+ OLLAMA_MODEL)
LLM_BASE_URL wins when both are set."""
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


_THINK_RE = re.compile(r"<think>[\s\S]*?</think>", re.I)


def openai_configured(env=None):
    return bool((env or os.environ).get("LLM_BASE_URL"))


def openai_call_json(env=None):
    """An OpenAI-compatible chat endpoint (llama.cpp llama-server, vLLM...). Asks for a JSON object, drops any <think> block."""
    env = env or os.environ
    base = env["LLM_BASE_URL"].rstrip("/")
    model = env.get("LLM_MODEL") or "qwen3-8b"
    key = env.get("LLM_API_KEY") or ""
    timeout = float(env.get("TESTOPS_MOBILE_LLM_TIMEOUT_MS", 120000)) / 1000
    temp = float(env.get("LLM_TEMPERATURE", 0.2))

    async def call(prompt):
        headers = {"Authorization": f"Bearer {key}"} if key else {}
        body = {"model": model, "messages": [{"role": "user", "content": prompt}], "temperature": temp, "stream": False, "response_format": {"type": "json_object"}}
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(base + "/chat/completions", json=body, headers=headers)
        if r.status_code in (401, 403):
            raise RuntimeError("The model server refused the key (set LLM_API_KEY)")
        if r.status_code != 200:
            raise RuntimeError(f"The model server answered {r.status_code}")
        msg = ((r.json().get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        return parse_json(_THINK_RE.sub("", msg))

    return call


def provider(env=None):
    env = env or os.environ
    return "openai-compatible" if openai_configured(env) else ("ollama" if ollama_configured(env) else None)


def call_json_from_env(env=None):
    """The model door the platform uses, from the environment; None when no model is set up."""
    p = provider(env)
    return openai_call_json(env) if p == "openai-compatible" else ollama_call_json(env) if p == "ollama" else None
