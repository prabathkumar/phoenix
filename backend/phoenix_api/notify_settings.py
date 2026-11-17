"""Notification settings kept in Phoenix itself (set from the Settings screen), not only in environment files.
- Secrets (tokens, webhook addresses, passwords) are encrypted at rest with PHOENIX_SETTINGS_KEY; with no key, secrets are REFUSED, never stored in plain text.
- Reading the settings never returns a secret: only "set" or "not set". A value left blank on save stays as it was; "clear" removes it.
- Only people named in PHOENIX_ADMINS (work addresses, comma list) may change settings. With none named, nobody can: it fails closed. Every change is written to the audit log (who, which keys, never the values).
- A setting saved here overrides the same name in the environment. Everything is validated before it is stored; SMS and voice services are refused."""
import base64
import hashlib
import json
import os
import re
import time

from . import notify

SCHEMA = [
    {"id": "general", "name": "General", "fields": [
        {"key": "PHOENIX_PUBLIC_URL", "label": "Public address of Phoenix", "help": "https, no trailing slash. Used for links in messages and for Twilio and Teams callbacks.", "kind": "url"},
        {"key": "PHOENIX_NOTIFY_MIN", "label": "Lowest level that is sent", "kind": "select", "options": ["info", "warn", "error"]},
        {"key": "NOTIFY_DIGEST_MINUTES", "label": "Digest every (minutes)", "help": "Defects raised and executions failed are counted and sent as one message.", "kind": "int", "min": 1, "max": 1440},
        {"key": "NOTIFY_PERSONAL_PHONE", "label": "Allow people to give their own mobile for WhatsApp", "help": "Off by default (PDPA). Leave off to reach people by Teams, the TestOps app and email.", "kind": "select", "options": ["", "allow"]},
    ]},
    {"id": "whatsapp", "name": "WhatsApp", "fields": [
        {"key": "WHATSAPP_PROVIDER", "label": "Provider", "kind": "select", "options": ["", "twilio"], "help": "Blank = Meta Cloud API directly."},
        {"key": "WHATSAPP_TO", "label": "Company numbers that receive alerts", "help": "Numbers issued by the company (an on-call phone), comma list, international format.", "kind": "phones"},
        {"key": "WHATSAPP_TOKEN", "label": "Meta access token", "secret": True},
        {"key": "WHATSAPP_PHONE_ID", "label": "Meta phone number id"},
        {"key": "WHATSAPP_TEMPLATE", "label": "Meta template name"},
        {"key": "TWILIO_ACCOUNT_SID", "label": "Twilio account SID"},
        {"key": "TWILIO_AUTH_TOKEN", "label": "Twilio auth token", "secret": True},
        {"key": "TWILIO_WHATSAPP_FROM", "label": "Twilio WhatsApp sender", "kind": "phone"},
        {"key": "TWILIO_CONTENT_SID", "label": "Twilio template (content) SID"},
    ]},
    {"id": "teams", "name": "Microsoft Teams and the directory", "fields": [
        {"key": "TEAMS_WEBHOOK_URL", "label": "Teams channel webhook", "secret": True, "kind": "url"},
        {"key": "MS_TENANT_ID", "label": "Entra tenant id"},
        {"key": "MS_CLIENT_ID", "label": "Entra app (client) id"},
        {"key": "MS_CLIENT_SECRET", "label": "Entra app secret", "secret": True},
        {"key": "MS_TEAMS_APP_ID", "label": "Phoenix Teams app id", "help": "Same as the client id of the app registration."},
        {"key": "MS_MAIL_SENDER", "label": "Sender mailbox for email through Microsoft"},
    ]},
    {"id": "slack", "name": "Slack", "fields": [
        {"key": "SLACK_WEBHOOK_URL", "label": "Incoming webhook", "secret": True, "kind": "url"},
        {"key": "SLACK_BOT_TOKEN", "label": "Bot token (instead of a webhook)", "secret": True},
        {"key": "SLACK_CHANNEL", "label": "Channel"},
    ]},
    {"id": "app", "name": "TestOps mobile app", "fields": [
        {"key": "TESTOPS_PUSH_URL", "label": "Push address of the app", "kind": "url"},
        {"key": "TESTOPS_PUSH_TOKEN", "label": "Push token", "secret": True},
    ]},
    {"id": "email", "name": "Email (SMTP)", "fields": [
        {"key": "SMTP_HOST", "label": "SMTP server"}, {"key": "SMTP_PORT", "label": "Port", "kind": "int", "min": 1, "max": 65535},
        {"key": "SMTP_USER", "label": "User"}, {"key": "SMTP_PASS", "label": "Password", "secret": True},
        {"key": "SMTP_FROM", "label": "From address"}, {"key": "EMAIL_TO", "label": "Team mailbox (comma list)"},
    ]},
    {"id": "others", "name": "Telegram, Discord, Google Chat, ntfy, webhook", "fields": [
        {"key": "TELEGRAM_BOT_TOKEN", "label": "Telegram bot token", "secret": True}, {"key": "TELEGRAM_CHAT_ID", "label": "Telegram chat id"},
        {"key": "DISCORD_WEBHOOK_URL", "label": "Discord webhook", "secret": True, "kind": "url"},
        {"key": "GOOGLE_CHAT_WEBHOOK_URL", "label": "Google Chat webhook", "secret": True, "kind": "url"},
        {"key": "NTFY_URL", "label": "ntfy topic address", "kind": "url"}, {"key": "NTFY_TOKEN", "label": "ntfy token", "secret": True},
        {"key": "NOTIFY_WEBHOOK_URL", "label": "Your own webhook", "kind": "url"}, {"key": "NOTIFY_WEBHOOK_SECRET", "label": "Webhook signing secret", "secret": True},
    ]},
    {"id": "platforms", "name": "Ready-made platforms (Courier, Apprise)", "fields": [
        {"key": "COURIER_AUTH_TOKEN", "label": "Courier auth token", "secret": True},
        {"key": "COURIER_TO", "label": "Courier recipient (JSON)", "help": '{"list_id":"phoenix-ops"}', "kind": "json"},
        {"key": "COURIER_CHANNELS", "label": "Courier channels to use", "help": "e.g. whatsapp,slack,email. SMS and voice are never used."},
        {"key": "NOTIFY_VIA", "label": "Send only through Courier", "kind": "select", "options": ["", "courier-only"]},
        {"key": "APPRISE_URL", "label": "Apprise container address", "help": "e.g. http://apprise:8000", "kind": "url-internal"},
        {"key": "APPRISE_KEY", "label": "Apprise saved-config key", "secret": True}, {"key": "APPRISE_TAG", "label": "Apprise tag"},
        {"key": "APPRISE_URLS", "label": "Apprise service links", "secret": True, "help": "Comma list. SMS and call services are refused."},
    ]},
]
FIELDS = {f["key"]: f for s in SCHEMA for f in s["fields"]}
SECRET = {k for k, f in FIELDS.items() if f.get("secret")}


def _path(env):
    return os.path.join(env.get("PHOENIX_DATA_DIR", "."), "notify-settings.json")


def _fernet(env):
    key = env.get("PHOENIX_SETTINGS_KEY", "")
    if len(key) < 16:
        return None
    from cryptography.fernet import Fernet
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(("phoenix-notify|" + key).encode()).digest()))


def _read(env):
    try:
        return json.load(open(_path(env)))
    except Exception:
        return {}


def load(env):
    """The saved settings, secrets decrypted, for the sender to use. A secret that cannot be decrypted (wrong or missing key) is left out, never guessed."""
    out, f = {}, _fernet(env)
    for k, v in _read(env).items():
        if k not in FIELDS:
            continue
        if isinstance(v, dict) and "enc" in v:
            if not f:
                continue
            try:
                out[k] = f.decrypt(v["enc"].encode()).decode()
            except Exception:
                continue
        elif isinstance(v, str) and k not in SECRET:
            out[k] = v
    return out


def is_admin(env, who):
    return str(who or "").strip().lower() in [a.strip().lower() for a in env.get("PHOENIX_ADMINS", "").split(",") if a.strip()]


def view(env):
    """What the screen shows: the fields, current plain values, and for secrets only whether they are set. Plus where each value comes from."""
    saved, f = _read(env), _fernet(env)
    eff = notify.resolve(env)
    sections = []
    for s in SCHEMA:
        fields = []
        for fl in s["fields"]:
            k = fl["key"]
            has = bool(eff.get(k))
            fields.append({**fl, "set": has, "source": "screen" if k in saved else ("environment" if env.get(k) else ""), **({} if fl.get("secret") else {"value": eff.get(k, "")})})
        sections.append({"id": s["id"], "name": s["name"], "fields": fields})
    return {"sections": sections, "channels": notify.channels(eff), "canStoreSecrets": bool(f), "admins": bool([a for a in env.get("PHOENIX_ADMINS", "").split(",") if a.strip()])}


def validate(key, value):
    """-> error text or None. Looks at the shape of the value only."""
    f = FIELDS[key]
    v = str(value)
    if len(v) > 4000:
        return "too long"
    kind = f.get("kind", "text")
    if kind == "url" and v and not notify._https(v) and not notify._internal(v):
        return "must be an https address"
    if kind == "url" and v:
        for plat, field in (("slack", "SLACK_WEBHOOK_URL"), ("teams", "TEAMS_WEBHOOK_URL"), ("discord", "DISCORD_WEBHOOK_URL"), ("google-chat", "GOOGLE_CHAT_WEBHOOK_URL")):
            if key == field and not notify._https(v, plat):
                return f"that is not a {plat} address"
    if kind == "url-internal" and v and not (notify._https(v) or notify._internal(v)):
        return "must be https, or http to a container on this network (like http://apprise:8000)"
    if kind == "int":
        if not re.fullmatch(r"\d{1,6}", v) or not (f["min"] <= int(v) <= f["max"]):
            return f"a whole number from {f['min']} to {f['max']}"
    if kind == "select" and v not in f["options"]:
        return "not an allowed choice"
    if kind == "phone" and v and not re.fullmatch(r"\+?\d{8,15}", re.sub(r"[\s()-]", "", v)):
        return "looks like +14155238886"
    if kind == "phones" and v and not all(re.fullmatch(r"\+?\d{8,15}", re.sub(r"[\s()-]", "", x)) for x in v.split(",") if x.strip()):
        return "a comma list of international numbers, like +6591234567"
    if kind == "json" and v:
        try:
            if not isinstance(json.loads(v), dict):
                return "must be a JSON object"
        except Exception:
            return "must be valid JSON"
    if key == "COURIER_CHANNELS" and any(x.strip().lower() in notify.NO_PHONE_CHANNELS for x in v.split(",")):
        return "SMS and voice are not allowed"
    if key == "APPRISE_URLS" and v:
        ok, bad = notify._apprise_urls_ok([x for x in v.split(",") if x.strip()])
        if not ok:
            return "SMS and call services are not allowed: " + ", ".join(b.split("://")[0] for b in bad)
    return None


def save(env, who, values):
    """values = {KEY: text}. "" or missing = keep as is; "clear" = remove. Returns {changed: [keys]}; raises PermissionError / ValueError with a message the screen can show."""
    if not is_admin(env, who):
        raise PermissionError("Only a Phoenix administrator can change notification settings (PHOENIX_ADMINS lists them).")
    if not isinstance(values, dict):
        raise ValueError("values must be an object")
    f, saved, changed = _fernet(env), _read(env), []
    unknown = [k for k in values if k not in FIELDS]
    if unknown:
        raise ValueError(f"unknown setting: {unknown[0]}")
    for k, v in values.items():
        v = "" if v is None else str(v)
        if v == "" and not (FIELDS[k].get("kind") == "select"):
            continue
        if v == "clear":
            if saved.pop(k, None) is not None:
                changed.append(k)
            continue
        err = validate(k, v)
        if err:
            raise ValueError(f"{FIELDS[k]['label']}: {err}")
        if k in SECRET:
            if not f:
                raise ValueError("Secrets cannot be stored: set PHOENIX_SETTINGS_KEY (16+ characters) on the server first, so they can be encrypted.")
            saved[k] = {"enc": f.encrypt(v.encode()).decode()}
        else:
            saved[k] = v
        changed.append(k)
    os.makedirs(os.path.dirname(os.path.abspath(_path(env))), exist_ok=True)
    tmp = _path(env) + ".tmp"
    json.dump(saved, open(tmp, "w"), indent=1)
    os.chmod(tmp, 0o600)
    os.replace(tmp, _path(env))
    return {"changed": sorted(set(changed)), "at": int(time.time())}
