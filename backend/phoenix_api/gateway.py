"""The gateway: every model call goes through here.
 call_prompt(name, ...) published prompt -> input guardrails -> models in order (fallback) -> output guardrails -> log
 wrap(call_json, name)  same checks and log around any existing async call_json(prompt)
The log goes to ClickHouse (analytics.gateway_calls): prompt id and version, model, latency, sizes, guardrail hits, status, run id.
It never holds the prompt text, the input or the answer."""
import json
import time

from . import analytics, db, guardrails as guard, mcp_registry, prompt_store as store

MAX_TOOL_CALLS = 3


def _db(env):
    return (env or {}).get("DATABASE_URL")


def rules_for(names, env=None):
    allr = guard.DEFAULT_RULES
    custom = db.doc_get("guardrails", "all", _db(env))
    if custom and isinstance(custom.get("rules"), list):
        allr = custom["rules"]
    return [r for r in allr if r["id"] in names] if names else [r for r in allr if r.get("default") is not False]


def save_rules(rules, env=None):
    for r in rules:
        guard.check({**r, "action": "warn"}, "")  # rejects unknown types
    db.doc_put("guardrails", "all", {"rules": rules}, _db(env))


def read_log(n=100, run=None):
    return analytics.default().calls(n=n, run=run)


def _log(rec):
    analytics.default().insert("gateway_calls", {k: rec.get(k, d) for k, d in (("run", ""), ("name", ""), ("prompt", ""), ("version", 0), ("model", ""), ("status", ""), ("ms", 0), ("in_chars", 0), ("out_chars", 0), ("fell_back", 0), ("hits", []), ("tool", ""))})


async def _via_models(models, providers, prompt):
    tried = []
    for m in models:
        p = providers.get(m)
        if not p:
            tried.append(f"{m}: not configured")
            continue
        try:
            return m, await p(prompt), tried
        except Exception as e:
            tried.append(f"{m}: {e}")
    raise RuntimeError(f"No model answered ({'; '.join(tried)})")


async def execute(prompt_id, version, input, models, providers, rules, secrets, name, run):
    t0 = time.time()
    ms = lambda: int((time.time() - t0) * 1000)  # noqa: E731
    gin = guard.run(rules, "input", input, secrets)
    base = {"run": run or "", "name": name, "prompt": prompt_id, "version": version, "in_chars": len(str(input))}
    hits = lambda rs: [h for r in rs if r["hit"] for h in [f"{r['id']}"]]  # noqa: E731
    if gin["blocked"]:
        _log({**base, "status": "blocked-input", "hits": hits(gin["results"]), "ms": ms()})
        return {"ok": False, "blocked": "input", "error": "Blocked by a guardrail on the input.", "guardrails": gin["results"]}
    try:
        model, value, tried = await _via_models(models, providers, gin["text"])
    except Exception as e:
        _log({**base, "status": "model-error", "ms": ms()})
        return {"ok": False, "error": str(e), "guardrails": gin["results"]}
    raw = value if isinstance(value, str) else json.dumps(value)
    gout = guard.run(rules, "output", raw, secrets)
    results = gin["results"] + gout["results"]
    log = {**base, "model": model, "fell_back": len(tried), "hits": hits(results), "out_chars": len(raw), "ms": ms()}
    if gout["blocked"]:
        _log({**log, "status": "blocked-output"})
        return {"ok": False, "blocked": "output", "error": "Blocked by a guardrail on the answer.", "guardrails": results}
    if gout["text"] != raw:
        try:
            value = gout["text"] if isinstance(value, str) else json.loads(gout["text"])
        except Exception:
            value = gout["text"]
    _log({**log, "status": "ok"})
    return {"ok": True, "value": value, "model": model, "guardrails": results}


async def call_prompt(name, platform="shared", vars=None, input="", providers=None, default_models=(), secrets=(), env=None, run=None, fetch=None):
    p = store.get_prompt(name, platform, vars or {}, env)
    rec = p["record"]
    allowed = rec.get("mcp") or []
    text = f"{p['text']}\n\n{input}" if input else p["text"]
    if allowed:
        known = [(f"{s['id']}/{t['name']}", t["description"]) for s in mcp_registry.list_servers(env) if s["enabled"] for t in s["tools"]]
        usable = [(r, d) for r, d in known if r in allowed]
        if usable:
            text += '\n\nYou may use a tool before answering. To call one, reply only {"tool":"server/tool","args":{...}}. Tools:\n' + "\n".join(f"- {r}: {d}" for r, d in usable)
    models = rec.get("models") or list(default_models)
    used = []
    i = 0
    while True:
        r = await execute(p["id"], p["version"], text, models, providers or {}, rules_for(rec.get("guardrails"), env), secrets, name, run)
        v = r.get("value")
        wants = r["ok"] and allowed and isinstance(v, dict) and isinstance(v.get("tool"), str)
        if not wants:
            return {**r, "toolCalls": used} if used else r
        if i >= MAX_TOOL_CALLS:
            return {**r, "ok": False, "error": f"The model kept asking for tools (more than {MAX_TOOL_CALLS}).", "toolCalls": used}
        try:
            kw = {"fetch": fetch} if fetch else {}
            result = await mcp_registry.call_tool(v["tool"], v.get("args"), allowed, env, **kw)
            used.append(v["tool"])
            _log({"run": run or "", "name": name, "prompt": p["id"], "version": p["version"], "status": "tool", "tool": v["tool"]})
        except Exception as e:
            result = {"error": str(e)}
        text += f"\n\nTOOL RESULT ({v['tool']}): {json.dumps(result)[:4000]}\nNow give your answer, or call another tool."
        i += 1


def wrap(call_json, name="adhoc", models=("default",), extra=None, secrets=(), env=None, run=None):
    """A drop-in call_json: same checks, log and fallback around a plain async model function. Raises on a block."""
    providers = {"default": call_json, **(extra or {})}

    async def call(prompt):
        r = await execute(f"{name}:adhoc", 0, prompt, list(models), providers, rules_for(None, env), secrets, name, run)
        if not r["ok"]:
            raise RuntimeError(r["error"])
        return r["value"]

    return call
