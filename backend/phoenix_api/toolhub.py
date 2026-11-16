"""Open source tools as separate containers, and the gate every upgrade passes through.
- tools/tools.json lists the tools and their pinned image versions. The platform's own lock file (PHOENIX_DATA_DIR/tools.lock.json) holds what is live now, what was live before, and the scan baseline.
- An upgrade never touches the live version. upgrade(): find the newest release, pull it ASIDE, scan it (the VA: Trivy on the image; Semgrep and Gitleaks on the tool's own source at that tag),
  decide, and only then promote. After promoting, a health check runs the new container; if it fails the previous version is put back (self-healing) and a person is told.
- Every outcome goes to the phone (notify.py): blocked, promoted, or rolled back."""
import json
import os
import re
import shutil
import subprocess
import tempfile
import time

from . import http as _http, notify, test_connectors as tcx

REGISTRY = os.path.join(os.path.dirname(__file__), "..", "..", "tools", "tools.json")
TAG = re.compile(r"^[\w][\w.-]{0,63}$")
IMAGE = re.compile(r"^[a-z0-9][a-z0-9._/-]{0,100}$")


def registry(path=REGISTRY):
    return json.load(open(path))["tools"]


def _lock_path(env):
    return os.path.join(env.get("PHOENIX_DATA_DIR", "."), "tools.lock.json")


def read_lock(env):
    try:
        return json.load(open(_lock_path(env)))
    except Exception:
        return {}


def write_lock(env, lock):
    os.makedirs(os.path.dirname(os.path.abspath(_lock_path(env))), exist_ok=True)
    tmp = _lock_path(env) + ".tmp"
    json.dump(lock, open(tmp, "w"), indent=1)
    os.replace(tmp, _lock_path(env))


def live(tool_id, env, reg=None):
    t = (reg or registry())[tool_id]
    v = (read_lock(env).get(tool_id) or {}).get("version") or t["version"]
    return t["image"], v


def image_ref(tool_id, env, reg=None):
    img, v = live(tool_id, env, reg)
    return f"{img}:{v}"


def docker_argv(image, args, mount=None, network=False, workdir="/src"):
    """A throw-away container: no network unless asked, read-only mount of the folder to scan, never privileged, no host socket."""
    if not IMAGE.match(image.split(":")[0]):
        raise ValueError("bad image name")
    a = ["docker", "run", "--rm", "--cap-drop=ALL", "--security-opt=no-new-privileges", *([] if network else ["--network", "none"])]
    if mount:
        a += ["-v", f"{os.path.realpath(mount)}:{workdir}:ro", "-w", workdir]
    return a + [image, *args]


def status(env, reg=None):
    reg, lock = reg or registry(), read_lock(env)
    return [{"id": k, "purpose": t["purpose"], "image": f"{t['image']}:{(lock.get(k) or {}).get('version') or t['version']}", "version": (lock.get(k) or {}).get("version") or t["version"],
             "previous": (lock.get(k) or {}).get("previous"), "lastCheck": (lock.get(k) or {}).get("checked"), "baseline": (lock.get(k) or {}).get("baseline")} for k, t in reg.items()]


async def latest_version(tool, fetch=_http.fetch):
    st, text = await fetch("GET", f"https://api.github.com/repos/{tool['repo']}/releases/latest", {"Accept": "application/vnd.github+json"}, None)
    if st != 200:
        raise RuntimeError(f"could not read the latest release of {tool['repo']} (HTTP {st})")
    tag = str(json.loads(text).get("tag_name", ""))
    v = tag[len(tool.get("tagPrefix", "")):] if tool.get("tagPrefix") and tag.startswith(tool["tagPrefix"]) else tag
    if not TAG.match(v):
        raise RuntimeError("the latest release has an unusable tag")
    return v


def _count_trivy(out):
    c = {"CRITICAL": 0, "HIGH": 0}
    try:
        for r in json.loads(out).get("Results", []) or []:
            for v in r.get("Vulnerabilities") or []:
                if v.get("Severity") in c:
                    c[v["Severity"]] += 1
    except Exception:
        return None
    return c


def _count_semgrep(out):
    try:
        return sum(1 for r in json.loads(out).get("results", []) if (r.get("extra") or {}).get("severity") == "ERROR")
    except Exception:
        return None


def _count_gitleaks(out):
    try:
        j = json.loads(out or "[]")
        return len(j) if isinstance(j, list) else None
    except Exception:
        return None


def scan(tool_id, tool, version, env, run=subprocess.run, reg=None, clone=tcx.clone):
    """The VA: Trivy on the new image, Semgrep and Gitleaks on the tool's source at that release. A scan that cannot run is reported as such, never as clean."""
    counts, why = {"image": None, "sast": None, "secrets": None}, []
    trivy = image_ref("trivy", env, reg)
    ref = f"{tool['image']}:{version}"
    try:
        p = run(docker_argv(trivy, ["image", "--quiet", "--format", "json", "--severity", "HIGH,CRITICAL", "--scanners", "vuln", ref], network=True), capture_output=True, text=True, timeout=900)
        counts["image"] = _count_trivy(p.stdout)
        if counts["image"] is None:
            why.append("image scan gave no result")
    except Exception as e:
        why.append(f"image scan failed: {str(e)[:80]}")
    src = None
    try:
        src = clone(f"https://github.com/{tool['repo']}", f"{tool.get('tagPrefix', '')}{version}")
        p = run(docker_argv(image_ref("semgrep", env, reg), ["semgrep", "--config", "p/security-audit", "--json", "--quiet", "/src"], mount=src, network=True), capture_output=True, text=True, timeout=1800)
        counts["sast"] = _count_semgrep(p.stdout)
        g = run(docker_argv(image_ref("gitleaks", env, reg), ["detect", "--no-git", "-s", "/src", "--report-format", "json", "--report-path", "/dev/stdout", "--exit-code", "0", "--redact"], mount=src), capture_output=True, text=True, timeout=900)
        counts["secrets"] = _count_gitleaks((g.stdout or "").strip().split("\n[")[-1] if g.stdout else "[]")
        if counts["sast"] is None or counts["secrets"] is None:
            why.append("source scan gave no result")
    except Exception as e:
        why.append(f"source scan failed: {str(e)[:80]}")
    finally:
        if src:
            shutil.rmtree(src, ignore_errors=True)
    return {"counts": counts, "incomplete": why}


def gate(counts, incomplete, baseline=None):
    """Block when: a scan could not run; a CRITICAL vulnerability is in the image; any secret is in the source; or SAST errors / HIGH vulnerabilities grew past the live version's baseline."""
    reasons, base = [], baseline or {}
    reasons += [f"scan incomplete: {w}" for w in incomplete]
    im = counts.get("image") or {}
    if im.get("CRITICAL", 0) > 0:
        reasons.append(f"{im['CRITICAL']} CRITICAL vulnerabilit{'y' if im['CRITICAL'] == 1 else 'ies'} in the image")
    if (counts.get("secrets") or 0) > 0:
        reasons.append(f"{counts['secrets']} secret(s) in the source")
    if base:
        if im.get("HIGH", 0) > (base.get("image") or {}).get("HIGH", 10**9):
            reasons.append(f"HIGH vulnerabilities grew from {(base.get('image') or {}).get('HIGH')} to {im.get('HIGH')}")
        if (counts.get("sast") or 0) > (base.get("sast") if base.get("sast") is not None else 10**9):
            reasons.append(f"SAST errors grew from {base.get('sast')} to {counts.get('sast')}")
    return {"ok": not reasons, "reasons": reasons}


def healthy(tool_id, tool, version, run=subprocess.run):
    try:
        p = run(docker_argv(f"{tool['image']}:{version}", tool["health"]), capture_output=True, text=True, timeout=120)
        return p.returncode == 0
    except Exception:
        return False


async def upgrade(tool_id, env, who="", run=subprocess.run, fetch=_http.fetch, reg=None, clone=tcx.clone, send=notify.send):
    """Check, pull aside, scan, decide, promote, health-check, roll back if needed. Returns {tool, from, to, outcome, ...}. Outcome: current | blocked | promoted | rolled-back | failed."""
    reg = reg or registry()
    if tool_id not in reg:
        raise ValueError(f"unknown tool '{tool_id}'")
    tool, lock = reg[tool_id], read_lock(env)
    cur = (lock.get(tool_id) or {}).get("version") or tool["version"]
    entry = lock.setdefault(tool_id, {"version": cur})
    entry["checked"] = int(time.time())
    try:
        new = await latest_version(tool, fetch)
    except Exception as e:
        write_lock(env, lock)
        return {"tool": tool_id, "from": cur, "outcome": "failed", "detail": str(e)}
    if new == cur or tool["version"] in ("stable", "latest"):
        write_lock(env, lock)
        return {"tool": tool_id, "from": cur, "to": new, "outcome": "current", "detail": f"{tool_id} {cur} is the newest release"}
    try:
        p = run(["docker", "pull", f"{tool['image']}:{new}"], capture_output=True, text=True, timeout=1200)
        if p.returncode != 0:
            raise RuntimeError((p.stderr or "pull failed")[-120:])
    except Exception as e:
        write_lock(env, lock)
        return {"tool": tool_id, "from": cur, "to": new, "outcome": "failed", "detail": f"could not pull {new}: {str(e)[:120]}"}
    s = scan(tool_id, tool, new, env, run, reg, clone)
    g = gate(s["counts"], s["incomplete"], entry.get("baseline"))
    base = {"tool": tool_id, "from": cur, "to": new, "scan": s["counts"]}
    if not g["ok"]:
        write_lock(env, lock)
        await send("upgrade-blocked", f"{tool_id} {new} blocked", f"The VA scan blocked the upgrade from {cur}: " + "; ".join(g["reasons"]) + f". {tool_id} {cur} stays live.", env)
        return {**base, "outcome": "blocked", "detail": "; ".join(g["reasons"]), "reasons": g["reasons"]}
    old = dict(entry)
    entry.update({"previous": cur, "version": new, "baseline": s["counts"], "promotedAt": int(time.time()), "promotedBy": who or "system"})
    write_lock(env, lock)
    if not healthy(tool_id, tool, new, run):
        lock[tool_id] = old                       # self-healing: the version that worked is live again, with its own baseline
        write_lock(env, lock)
        await send("upgrade-rolled-back", f"{tool_id} {new} rolled back", f"{tool_id} {new} passed the scan but did not start, so {cur} is live again.", env)
        return {**base, "outcome": "rolled-back", "detail": f"{new} failed its health check; {cur} restored"}
    await send("upgrade-promoted", f"{tool_id} upgraded to {new}", f"Scan clean, health check passed. Was {cur}.", env)
    return {**base, "outcome": "promoted", "detail": f"{cur} to {new}: scan clean, healthy"}
