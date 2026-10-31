"""
FrothTestOps unified prompt registry - Python loader (Django / Celery).

    from prompts.registry import get_prompt

    system_prompt, prompt_id = get_prompt("testcase_target")
    logger.info("[LLM] prompt_id=%s", prompt_id)

Platforms: "web", "mobile", or "shared" (falls back to "shared" when a platform
variant is not defined). The file hot-reloads when prompts.yaml changes.
Override the file location with the PROMPTS_FILE environment variable.
"""
import hashlib
import os
import pathlib
import threading

import yaml

_PATH = pathlib.Path(os.getenv("PROMPTS_FILE") or pathlib.Path(__file__).with_name("prompts.yaml"))
_lock = threading.Lock()
_cache = {"mtime": None, "data": None}


def _load() -> dict:
    mtime = _PATH.stat().st_mtime
    with _lock:
        if _cache["mtime"] != mtime:
            data = yaml.safe_load(_PATH.read_text(encoding="utf-8"))
            _validate(data)
            _cache["data"], _cache["mtime"] = data, mtime
        return _cache["data"]


def _validate(data: dict) -> None:
    blocks, prompts = data.get("blocks", {}), data.get("prompts", {})
    for name, variants in prompts.items():
        for platform, block_list in variants.items():
            missing = [b for b in block_list if b not in blocks]
            if missing:
                raise ValueError(f"prompt '{name}:{platform}' references unknown blocks: {missing}")


def get_prompt(name: str, platform: str = "shared", **variables) -> tuple:
    """Return (prompt_text, prompt_id). Log prompt_id with every LLM call."""
    reg = _load()
    if name not in reg["prompts"]:
        raise KeyError(f"unknown prompt '{name}'")
    variants = reg["prompts"][name]
    used = platform if platform in variants else "shared"
    if used not in variants:
        raise KeyError(f"prompt '{name}' has no '{platform}' or 'shared' variant")
    text = "\n\n".join(reg["blocks"][b].strip() for b in variants[used])
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
    prompt_id = f"{name}:{used}:{reg['version']}:{digest}"
    for key, value in variables.items():
        text = text.replace("{{" + key + "}}", str(value))
    return text, prompt_id


def list_prompts() -> dict:
    """{prompt_name: [platforms]} - handy for an admin page or a startup log line."""
    return {n: list(v.keys()) for n, v in _load()["prompts"].items()}
