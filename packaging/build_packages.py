#!/usr/bin/env python3
"""Builds the two packages testers install (see docs/LAPTOP_RUNNER.md):
  phoenix-runner-<version>.zip         laptop runner for Mac and Windows: unzip, double-click Install, then Start. Brings its own Node and browser; needs no admin rights.
  phoenix-runner-chrome-<version>.zip  the Chrome extension (upload to the Chrome Web Store as a private/unlisted item, or push it by company policy).
  python3 packaging/build_packages.py --server https://phoenix.yourcompany.com --out dist
--server is written into the package so testers only type their pairing code. Nothing secret goes into either zip."""
import argparse
import json
import os
import re
import sys
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SKIP_DIRS = {"node_modules", "test", "tests", ".git", "__pycache__", "browsers", "node"}
SKIP_FILES = re.compile(r"(\.db$|\.db-journal$|\.env|\.log$|\.test\.js$)")
PKG = os.path.join(ROOT, "packaging", "runner-package")
EXEC = {"Install.command", "Start.command"}


def _walk(rel):
    base = os.path.join(ROOT, rel)
    for d, dirs, files in os.walk(base):
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
        for f in sorted(files):
            if SKIP_FILES.search(f):
                continue
            full = os.path.join(d, f)
            yield os.path.relpath(full, ROOT), full


def _add(z, arc, data=None, path=None, mode=0o644):
    zi = zipfile.ZipInfo(arc, date_time=(2026, 1, 1, 0, 0, 0))
    zi.external_attr = (mode | 0o100000) << 16
    zi.compress_type = zipfile.ZIP_DEFLATED
    z.writestr(zi, data if data is not None else open(path, "rb").read())


def version():
    return json.load(open(os.path.join(ROOT, "extension", "phoenix-runner", "manifest.json")))["version"]


def build_runner(out, server=""):
    if server and not re.fullmatch(r"https://[A-Za-z0-9.-]+(:\d+)?", server):
        raise SystemExit("--server must look like https://phoenix.yourcompany.com (no path, no trailing slash)")
    name = f"phoenix-runner-{version()}.zip"
    top = "Phoenix-Runner/"
    with zipfile.ZipFile(os.path.join(out, name), "w") as z:
        for rel in ("runner", "web", "engine", "generation"):
            for arc, full in _walk(rel):
                if arc.startswith("engine" + os.sep) and arc.endswith(("package.json", "package-lock.json")):
                    continue                                     # the engine's Appium dependencies are not needed for web runs
                _add(z, top + arc.replace(os.sep, "/"), path=full)
        for f in sorted(x for x in os.listdir(PKG) if os.path.isfile(os.path.join(PKG, x))):
            _add(z, top + f, path=os.path.join(PKG, f), mode=0o755 if f in EXEC else 0o644)
        for sub in ("scripts",):
            for f in sorted(os.listdir(os.path.join(PKG, sub))):
                _add(z, f"{top}{sub}/{f}", path=os.path.join(PKG, sub, f))
        _add(z, top + "phoenix-server.txt", data=(server + "\n").encode())
        _add(z, top + "VERSION.txt", data=(version() + "\n").encode())
    return os.path.join(out, name)


def build_extension(out):
    src = os.path.join(ROOT, "extension", "phoenix-runner")
    name = f"phoenix-runner-chrome-{version()}.zip"
    with zipfile.ZipFile(os.path.join(out, name), "w") as z:
        for d, dirs, files in os.walk(src):
            dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
            for f in sorted(files):
                full = os.path.join(d, f)
                _add(z, os.path.relpath(full, src).replace(os.sep, "/"), path=full)       # manifest.json at the zip root, as the store requires
    return os.path.join(out, name)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default="")
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    for p in (build_runner(a.out, a.server), build_extension(a.out)):
        print(p, os.path.getsize(p) // 1024, "KB")
