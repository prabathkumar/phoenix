import json
import os
import subprocess
import sys
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "packaging"))
import build_packages as B  # noqa: E402


def test_runner_zip_has_installers_runner_and_no_secrets_or_junk(tmp_path):
    z = zipfile.ZipFile(B.build_runner(str(tmp_path), "https://phoenix.example.com"))
    names = z.namelist()
    for need in ("Install.command", "Start.command", "Install.bat", "Start.bat", "scripts/install.ps1", "README-FIRST.txt", "runner/phoenix-runner.js", "runner/allowlist.js", "web/web-test-case-runner.js", "web/package.json", "web/package-lock.json", "engine/test-case-runner.js", "phoenix-server.txt"):
        assert "Phoenix-Runner/" + need in names, need
    assert not [n for n in names if "node_modules" in n or n.endswith((".db", ".env", ".log")) or "/test/" in n or n.endswith("engine/package.json")]
    assert z.read("Phoenix-Runner/phoenix-server.txt").decode().strip() == "https://phoenix.example.com"
    assert (z.getinfo("Phoenix-Runner/Install.command").external_attr >> 16) & 0o111          # double-clickable on a Mac
    assert not any(b"PHOENIX_TEST_LOGIN" in z.read(n) or b"TESTOPS_SECRETS_KEY=" in z.read(n) for n in names if n.endswith((".js", ".txt", ".command", ".bat", ".ps1", ".json")))


def test_server_address_is_checked(tmp_path):
    for bad in ("http://x.com", "https://x.com/path", "https://u:p@x.com", "javascript:alert(1)"):
        try:
            B.build_runner(str(tmp_path), bad)
        except SystemExit:
            continue
        raise AssertionError(bad)


def test_extension_zip_is_store_ready(tmp_path):
    z = zipfile.ZipFile(B.build_extension(str(tmp_path)))
    m = json.loads(z.read("manifest.json"))
    assert m["manifest_version"] == 3 and set(m["permissions"]) == {"debugger", "tabs", "storage", "alarms"} and "host_permissions" not in m
    assert all(f in z.namelist() for f in ("background.js", "phoenix-runner-core.js", "phoenix-runner-tab.js", "options.html", "icons/128.png"))
    assert not [n for n in z.namelist() if n.startswith(("test/", "node_modules"))]


def test_install_scripts_have_valid_shell_syntax():
    for f in ("Install.command", "Start.command"):
        assert subprocess.run(["bash", "-n", os.path.join(ROOT, "packaging", "runner-package", f)]).returncode == 0


def test_tab_kit_is_two_scripts_with_instructions_and_stays_in_its_own_namespace(tmp_path):
    z = zipfile.ZipFile(B.build_tab_kit(str(tmp_path)))
    assert set(z.namelist()) == {"phoenix-runner-core.js", "phoenix-runner-tab.js", "INTEGRATION.md", "manifest-additions.json", "phoenix-runner-mount.js"}
    core, tab = z.read("phoenix-runner-core.js").decode(), z.read("phoenix-runner-tab.js").decode()
    assert "\nimport " not in core and "export " not in core.split("(function")[0]
    assert 'const KEY = "phoenixRunner"' in core and 'const KEY = "phoenixRunner"' in tab
    for host_key in ("chrome.storage.local.clear", "chrome.alarms.clearAll", "chrome.storage.sync"):
        assert host_key not in core and host_key not in tab                       # never wipes the host extension's data


def test_extension_allowlist_matches_the_runner_allowlist():
    """The extension carries its own copy of the allowlist rules: run the same cases through it with Node."""
    script = (
        "const fs=require('fs');const dummy=()=>new Proxy(function(){},{get:(t,k)=>k==='then'?undefined:dummy(),apply:()=>undefined});globalThis.chrome=dummy();"
        "globalThis.WebSocket=function(){};eval(fs.readFileSync(process.argv[1],'utf8'));const a=globalThis.PhoenixRunner.allowed;"
        "const A=['*.corp.example.com','intranet.local','10.20.0.0/16'];const assert=require('assert');"
        "assert(a('https://crm.corp.example.com/x',A));assert(!a('https://corp.example.com',A));assert(a('http://10.20.5.9/',A));assert(!a('http://10.21.0.1/',A));"
        "assert(!a('https://x.corp.example.com.evil.com',A));assert(!a('file:///etc/passwd',A));assert(!a('https://u:p@crm.corp.example.com',A));"
        "assert(!a('http://169.254.169.254/',['169.254.0.0/16','169.254.169.254']));assert(!a('https://crm.corp.example.com',[]));console.log('parity ok');")
    r = subprocess.run(["node", "-e", script, os.path.join(ROOT, "extension", "phoenix-runner", "phoenix-runner-core.js")], capture_output=True, text=True)
    assert r.returncode == 0 and "parity ok" in r.stdout, r.stderr
