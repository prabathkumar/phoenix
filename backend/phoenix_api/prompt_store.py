"""Prompt library: every prompt stored, versioned, with variables, published and rolled back from the UI.
One JSON file per prompt under TESTOPS_GATEWAY_DIR (default ./prompt-library): key = name + platform (shared|web|mobile).
A new edit is a new version; nothing is overwritten. 'Published' is the version calls use."""
import hashlib
import re
from datetime import datetime, timezone

from . import db

PLATFORMS = ("shared", "web", "mobile")
VAR = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
DEFAULTS = {
    "unit_test_gen": """You write unit tests. Given one source file, write one complete test file for it in the named language and framework.
Rules:
- Test the real behaviour of the public functions or methods: normal cases, edge cases (empty, null, boundaries) and error cases.
- Use only the framework named, and import the source file by the path given. Do not invent modules or helpers that are not in the source.
- No network, no real files, no secrets, no sleeping. Use plain inputs and fakes.
- If SEMGREP FINDINGS are listed, include a test that fails while that flagged code is still unsafe (for example, a hostile input that must be rejected).
- Each test has a name that says what it checks, and at least one assertion.
Reply with JSON {"code":"<the whole test file>"} and nothing else.""",
}


def _safe(s):
    s = str(s or "")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,63}", s):
        raise ValueError("Names use letters, numbers, dot, dash and underscore.")
    return s


def _key(name, platform):
    return f"{_safe(name)}.{platform if platform in PLATFORMS else 'shared'}"


def _read(name, platform, env=None):
    return db.doc_get("prompt", _key(name, platform), (env or {}).get("DATABASE_URL") if env else None)


def _write(rec, env=None):
    db.doc_put("prompt", _key(rec["name"], rec["platform"]), rec, (env or {}).get("DATABASE_URL") if env else None)


def vars_of(text):
    return list(dict.fromkeys(VAR.findall(str(text))))


def save_version(name, text, platform="shared", note="", by="", publish=True, guardrails=None, mcp=None, models=None, env=None):
    if not str(text or "").strip():
        raise ValueError("The prompt text is empty.")
    rec = _read(name, platform, env) or {"name": _safe(name), "platform": platform if platform in PLATFORMS else "shared", "versions": [], "published": 0, "guardrails": [], "mcp": [], "models": []}
    v = len(rec["versions"]) + 1
    rec["versions"].append({"v": v, "text": str(text), "vars": vars_of(text), "hash": hashlib.sha256(str(text).encode()).hexdigest()[:12],
                            "note": str(note)[:200], "by": str(by)[:80], "at": datetime.now(timezone.utc).isoformat()})
    if publish:
        rec["published"] = v
    for k, val in (("guardrails", guardrails), ("mcp", mcp), ("models", models)):
        if isinstance(val, list):
            rec[k] = val
    _write(rec, env)
    return rec


def publish(name, platform, v, env=None):
    rec = _read(name, platform, env)
    if not rec:
        raise ValueError(f'No prompt "{name}".')
    if not any(x["v"] == v for x in rec["versions"]):
        raise ValueError(f'Prompt "{name}" has no version {v}.')
    rec["published"] = v
    _write(rec, env)
    return rec


def set_settings(name, platform, guardrails=None, mcp=None, models=None, env=None):
    rec = _read(name, platform, env)
    if not rec:
        raise ValueError(f'No prompt "{name}".')
    for k, val in (("guardrails", guardrails), ("mcp", mcp), ("models", models)):
        if isinstance(val, list):
            rec[k] = val
    _write(rec, env)
    return rec


def list_prompts(env=None):
    out = []
    for r in db.doc_list("prompt", (env or {}).get("DATABASE_URL") if env else None):
        cur = next((x for x in r["versions"] if x["v"] == r["published"]), {})
        out.append({"name": r["name"], "platform": r["platform"], "published": r["published"], "versions": len(r["versions"]), "vars": cur.get("vars", []),
                    "guardrails": r["guardrails"], "mcp": r["mcp"], "models": r["models"], "at": cur.get("at")})
    return sorted(out, key=lambda r: r["name"] + r["platform"])


def get(name, platform="shared", env=None):
    return _read(name, platform, env)


def ensure_default(name, env=None):
    if name not in DEFAULTS or _read(name, "shared", env):
        return False
    save_version(name, DEFAULTS[name], note="shipped default", by="phoenix", env=env)
    return True


def get_prompt(name, platform="shared", vars=None, env=None):
    """Published text with {{vars}} filled; unknown vars are an error, not silently empty."""
    vars = vars or {}
    ensure_default(name, env)
    rec = _read(name, platform, env) or _read(name, "shared", env)
    if not rec:  # first use on a fresh database: load the shipped prompts.yaml library once, then look again
        try:
            import_registry(env=env)
        except Exception:
            pass
        rec = _read(name, platform, env) or _read(name, "shared", env)
    if not rec:
        raise ValueError(f"unknown prompt '{name}'")
    ver = next((x for x in rec["versions"] if x["v"] == rec["published"]), None)
    if not ver:
        raise ValueError(f"prompt '{name}' has no published version")
    missing = [k for k in ver["vars"] if k not in vars] if vars else []
    if missing:
        raise ValueError(f"prompt '{name}' needs: {', '.join(missing)}")
    text = VAR.sub(lambda m: str(vars[m.group(1)]) if m.group(1) in vars else m.group(0), ver["text"])
    return {"text": text, "id": f"{rec['name']}:{rec['platform']}:v{ver['v']}:{ver['hash']}", "version": ver["v"], "record": rec}


def import_registry(registry=None, env=None):
    """One-time import of prompts/prompts.yaml (via prompts/registry.py) as version 1 of each prompt. Skips ones that exist."""
    if registry is None:
        import importlib.util
        import pathlib
        spec = importlib.util.spec_from_file_location("prompts_registry", pathlib.Path(__file__).resolve().parents[2] / "prompts" / "registry.py")
        registry = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(registry)
    made = []
    for name, variants in registry._load()["prompts"].items():
        for platform in variants:
            if platform not in PLATFORMS or _read(name, platform, env):
                continue
            save_version(name, registry.get_prompt(name, platform)[0], platform, note="imported from prompts.yaml", by="import", env=env)
            made.append(f"{name}:{platform}")
    return made
