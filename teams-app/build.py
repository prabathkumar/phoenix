#!/usr/bin/env python3
"""Builds the Phoenix Teams app package (phoenix-teams-app.zip) for your tenant.
  python3 teams-app/build.py            reads MS_TEAMS_APP_ID (or MS_CLIENT_ID) and PHOENIX_PUBLIC_URL from the environment or .env
The app gives each person Phoenix alerts in the Teams activity feed (phone and desktop, by sign-in, no phone number) and a personal tab that opens Phoenix in Teams.
The package holds no secret. Its id MUST be the Application (client) id of the Entra app registration that has the TeamsActivity.Send permission."""
import json
import os
import re
import sys
import zipfile
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
GUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def manifest(app_id, public_url, developer="Phoenix test platform"):
    u = urlparse(public_url)
    host = u.hostname or ""
    base = f"{u.scheme}://{u.netloc}"
    return {
        "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
        "manifestVersion": "1.17", "version": "1.0.0", "id": app_id,
        "developer": {"name": developer[:32], "websiteUrl": base, "privacyUrl": base + "/privacy", "termsOfUseUrl": base + "/terms"},
        "name": {"short": "Phoenix", "full": "Phoenix test alerts"},
        "description": {"short": "Test runs, defects and upgrades, in Teams.", "full": "Phoenix tells you in Teams when a test run needs you, when defects are raised and when a tool upgrade is blocked. It uses your work sign-in only."},
        "icons": {"outline": "outline.png", "color": "color.png"}, "accentColor": "#2F5BEA",
        "staticTabs": [{"entityId": "phoenix-home", "name": "Phoenix", "contentUrl": base + "/", "websiteUrl": base + "/", "scopes": ["personal"]}],
        "activities": {"activityTypes": [{"type": "phoenixAlert", "description": "A Phoenix alert", "templateText": "{alert}"}]},
        "permissions": ["identity"], "validDomains": [host],
        "webApplicationInfo": {"id": app_id, "resource": f"api://{host}/{app_id}"},
    }


def check(m):
    """Problems that would make Teams reject the package. [] when it looks right."""
    bad = []
    if not GUID.match(str(m.get("id", ""))):
        bad.append("id must be a GUID (the Entra app's client id)")
    if m.get("webApplicationInfo", {}).get("id") != m.get("id"):
        bad.append("webApplicationInfo.id must equal id")
    if len(m["name"]["short"]) > 30 or len(m["description"]["short"]) > 80 or len(m["description"]["full"]) > 4000:
        bad.append("name or description is too long")
    for k in ("websiteUrl", "privacyUrl", "termsOfUseUrl"):
        if not str(m["developer"].get(k, "")).startswith("https://"):
            bad.append(f"developer.{k} must be https")
    if not m.get("validDomains") or not all(m["validDomains"]):
        bad.append("validDomains is empty")
    if not any(a["type"] == "phoenixAlert" for a in m.get("activities", {}).get("activityTypes", [])):
        bad.append("the phoenixAlert activity type is missing")
    return bad


def icons():
    from PIL import Image, ImageDraw
    import io
    c = Image.new("RGBA", (192, 192), (47, 91, 234, 255))
    d = ImageDraw.Draw(c)
    d.polygon([(96, 36), (140, 112), (112, 104), (122, 156), (96, 130), (70, 156), (80, 104), (52, 112)], fill=(255, 255, 255, 255))     # a simple flame-and-wings shape of our own
    o = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    ImageDraw.Draw(o).polygon([(16, 5), (23, 18), (18, 17), (20, 27), (16, 22), (12, 27), (14, 17), (9, 18)], fill=(255, 255, 255, 255))
    out = {}
    for name, im in (("color.png", c), ("outline.png", o)):
        b = io.BytesIO()
        im.save(b, "PNG")
        out[name] = b.getvalue()
    return out


def build(app_id, public_url, out_path):
    if not GUID.match(app_id or ""):
        raise SystemExit("MS_TEAMS_APP_ID (or MS_CLIENT_ID) must be the Entra app's Application (client) id, a GUID.")
    if not str(public_url or "").startswith("https://"):
        raise SystemExit("PHOENIX_PUBLIC_URL must be the https address people reach Phoenix on.")
    m = manifest(app_id.lower(), public_url.rstrip("/"))
    bad = check(m)
    if bad:
        raise SystemExit("not built: " + "; ".join(bad))
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(m, indent=2))
        for n, data in icons().items():
            z.writestr(n, data)
    return out_path


def _env_file():
    p = os.path.join(HERE, "..", ".env")
    out = {}
    if os.path.exists(p):
        for line in open(p):
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.strip().split("=", 1)
                out[k] = v.strip().strip('"').strip("'")
    return out


if __name__ == "__main__":
    e = {**_env_file(), **os.environ}
    out = os.path.join(HERE, "phoenix-teams-app.zip")
    build(e.get("MS_TEAMS_APP_ID") or e.get("MS_CLIENT_ID"), e.get("PHOENIX_PUBLIC_URL"), out)
    print(out)
