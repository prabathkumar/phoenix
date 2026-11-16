import asyncio
import json
import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from phoenix_api import notify, toolhub as T  # noqa: E402

REG = T.registry()


class R:
    def __init__(self, out="", rc=0, err=""):
        self.stdout, self.returncode, self.stderr = out, rc, err


def fake_run(trivy=None, semgrep=0, secrets=0, pull_ok=True, healthy=True, calls=None):
    trivy = trivy if trivy is not None else {"CRITICAL": 0, "HIGH": 2}

    def run(argv, **kw):
        if calls is not None:
            calls.append(argv)
        if argv[:2] == ["docker", "pull"]:
            return R(rc=0 if pull_ok else 1, err="denied")
        img = next((a for a in argv if "/" in a and ":" in a and not a.startswith(("/", "-"))), "")
        if "trivy" in " ".join(argv[:12]) and "image" in argv:
            return R(json.dumps({"Results": [{"Vulnerabilities": [{"Severity": "CRITICAL"}] * trivy["CRITICAL"] + [{"Severity": "HIGH"}] * trivy["HIGH"]}]}))
        if "semgrep" in argv:
            return R(json.dumps({"results": [{"extra": {"severity": "ERROR"}}] * semgrep}))
        if "detect" in argv:
            return R(json.dumps([{"RuleID": "x"}] * secrets))
        return R(rc=0 if healthy else 1)           # health check
    return run


def fetch_tag(tag):
    async def f(m, u, h, b):
        return 200, json.dumps({"tag_name": tag})
    return f


def up(tool, env, tag, run, sent):
    async def send(*a, **k):
        sent.append(a[:3])
        return {}
    return asyncio.run(T.upgrade(tool, env, "p", run, fetch_tag(tag), REG, lambda url, ref: "/nonexistent-clone", send))


def test_promote_then_block_then_rollback_each_tell_the_phone(tmp_path):
    env, sent = {"PHOENIX_DATA_DIR": str(tmp_path)}, []
    assert up("gitleaks", env, "v8.21.2", fake_run(), sent)["outcome"] == "current"
    r = up("gitleaks", env, "v8.30.0", fake_run(), sent)
    assert r["outcome"] == "promoted" and T.live("gitleaks", env)[1] == "v8.30.0" and sent[-1][0] == "upgrade-promoted"
    assert T.read_lock(env)["gitleaks"]["previous"] == "v8.21.2" and T.read_lock(env)["gitleaks"]["baseline"]["image"]["HIGH"] == 2
    # a critical vulnerability blocks; the live version does not move
    b = up("gitleaks", env, "v9.0.0", fake_run(trivy={"CRITICAL": 1, "HIGH": 0}), sent)
    assert b["outcome"] == "blocked" and "CRITICAL" in b["detail"] and T.live("gitleaks", env)[1] == "v8.30.0" and sent[-1][0] == "upgrade-blocked"
    # a secret in the source blocks
    assert up("gitleaks", env, "v9.0.1", fake_run(secrets=1), sent)["outcome"] == "blocked"
    # more HIGH than the live version's baseline blocks
    assert "HIGH vulnerabilities grew" in up("gitleaks", env, "v9.0.2", fake_run(trivy={"CRITICAL": 0, "HIGH": 5}), sent)["detail"]
    # clean but does not start: rolled back to the version that worked, with its own baseline
    rb = up("gitleaks", env, "v9.1.0", fake_run(healthy=False), sent)
    assert rb["outcome"] == "rolled-back" and T.live("gitleaks", env)[1] == "v8.30.0" and sent[-1][0] == "upgrade-rolled-back"
    assert T.read_lock(env)["gitleaks"]["baseline"]["image"]["HIGH"] == 2


def test_a_scan_that_cannot_run_blocks_and_a_failed_pull_changes_nothing(tmp_path):
    env, sent = {"PHOENIX_DATA_DIR": str(tmp_path)}, []

    def broken(argv, **kw):
        if argv[:2] == ["docker", "pull"]:
            return R()
        raise OSError("docker is gone")
    r = up("trivy", env, "v0.99.0", broken, sent)
    assert r["outcome"] == "blocked" and "scan incomplete" in r["detail"] and T.live("trivy", env)[1] == "0.57.0"
    assert up("trivy", env, "v0.99.0", fake_run(pull_ok=False), sent)["outcome"] == "failed"
    with pytest.raises(ValueError):
        asyncio.run(T.upgrade("nope", env))


def test_containers_are_locked_down_and_names_are_checked(tmp_path):
    a = T.docker_argv("aquasec/trivy:0.57.0", ["--version"], mount=str(tmp_path))
    assert "--network" in a and "none" in a and "--cap-drop=ALL" in a and f"{os.path.realpath(tmp_path)}:/src:ro" in a and "--privileged" not in a
    assert "--network" not in T.docker_argv("x/y:1", [], network=True)
    with pytest.raises(ValueError):
        T.docker_argv("evil; rm -rf /", [])
    assert asyncio.run(T.latest_version({"repo": "a/b", "tagPrefix": "v"}, fetch_tag("v1.2.3"))) == "1.2.3"
    with pytest.raises(RuntimeError):
        asyncio.run(T.latest_version({"repo": "a/b"}, fetch_tag("bad tag; x")))


def test_phone_channels_mask_and_never_raise():
    sent = []

    async def fetch(m, url, h, body):
        sent.append((url, h, json.loads(body)))
        return 200, "{}"
    env = {"TESTOPS_PUSH_URL": "https://push.test/x", "TESTOPS_PUSH_TOKEN": "t", "WHATSAPP_TOKEN": "w", "WHATSAPP_PHONE_ID": "123", "WHATSAPP_TO": "+6591234567, +60123456789"}
    assert set(notify.channels(env)) == {"testops-mobile", "whatsapp"} and notify.channels({}) == {}
    r = asyncio.run(notify.send("run-result", "Run failed", "password=hunter2hunter2 in step 3", env, fetch=fetch))
    assert r["testops-mobile"]["ok"] and r["whatsapp"]["ok"] and len(sent) == 3
    assert not any("hunter2hunter2" in json.dumps(x[2]) for x in sent)
    assert sent[1][2]["to"] == "6591234567" and sent[1][2]["type"] == "text" and sent[1][1]["Authorization"] == "Bearer w"

    async def boom(*a):
        raise OSError("offline")
    r2 = asyncio.run(notify.send("test", "t", "b", env, fetch=boom))
    assert not r2["testops-mobile"]["ok"] and not r2["whatsapp"]["ok"]
    assert asyncio.run(notify.send("test", "t", "b", {}, fetch=boom)) == {}
    tpl = asyncio.run(notify.send("test", "t", "b", {**env, "WHATSAPP_TEMPLATE": "alert"}, fetch=fetch))
    assert sent[-1][2]["type"] == "template" and tpl["whatsapp"]["ok"]
