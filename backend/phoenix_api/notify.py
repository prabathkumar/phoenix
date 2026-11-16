"""The notification platform: one place that tells people, on the channels they use. Nothing here ever raises; a channel that is not set up is reported, not guessed.
Channels (each set up by environment values, see docs/TOOLS_AND_NOTIFICATIONS.md): testops-mobile, whatsapp, slack, teams, telegram, discord, google-chat, email, ntfy, webhook.
Routing: which events go to which channel, from what severity up. Default: every set-up channel gets everything at "info" and above. Edit with PUT /api/notify/routes.
Every text is masked (logmask) and cut to each platform's size first. The same message is not sent twice within 60 seconds. A 5xx or a dropped connection is retried once.
Every delivery (and every failure) is kept in a short log and in the log store, so "did it reach them" can be answered."""
import asyncio
import hashlib
import hmac
import json
import os
import re
import smtplib
import threading
import time
from collections import deque
from email.message import EmailMessage
from urllib.parse import urlparse

from . import http as _http, logmask

SEVERITY = {"info": 0, "warn": 1, "error": 2}
HIGH_VOLUME = {"defect-raised", "execution-failed"}   # hundreds a day: never one message each; they are counted and sent as ONE digest
EVENTS = {"digest": "info", "defect-raised": "warn", "execution-failed": "warn", "test": "info", "run-result": "info", "needs-you": "warn", "scan-finding": "warn", "upgrade-promoted": "info", "upgrade-blocked": "warn", "upgrade-rolled-back": "error", "run-failed": "error"}
HOSTS = {   # the named platforms only accept their own hosts, so a mistyped or hijacked setting cannot send messages somewhere else
    "slack": r"(^|\.)slack\.com$", "teams": r"(\.webhook\.office\.com|\.logic\.azure\.com|\.powerplatform\.com|\.office\.com)$", "discord": r"^(discord|discordapp)\.com$", "google-chat": r"^chat\.googleapis\.com$",
}
_recent, _log = {}, deque(maxlen=200)


def _internal(url):
    """http is fine to a container on our own network (a single-word host such as http://apprise:8000) or to localhost; everything else needs https."""
    u = urlparse(str(url or ""))
    return u.scheme == "http" and bool(u.hostname) and ("." not in u.hostname or u.hostname in ("localhost", "127.0.0.1"))


def _https(url, platform=None):
    u = urlparse(str(url or ""))
    host = (u.hostname or "").lower()
    if u.scheme != "https" and not (u.scheme == "http" and host in ("localhost", "127.0.0.1")):
        return False
    return bool(re.search(HOSTS[platform], host)) if platform in HOSTS else bool(host)


NO_PHONE_CHANNELS = {"sms", "voice", "call", "calls", "phone", "text"}      # Phoenix never sends SMS or calls, through any provider


def _via_courier(env):
    """Courier is the ONLY sender only when NOTIFY_VIA=courier-only. Otherwise it is one more channel next to the others."""
    return env.get("NOTIFY_VIA") == "courier-only" and bool(env.get("COURIER_AUTH_TOKEN"))


def channels(env):
    """{channel: {ready, ...}} for every channel that is fully set up. Never shows a secret. With NOTIFY_VIA=courier, Courier is the ONLY sender (it fans out to WhatsApp, Slack, Teams, email and push)."""
    if _via_courier(env):
        return {"courier": {"ready": True, "to": bool(env.get("COURIER_TO")), "channels": [x for x in env.get("COURIER_CHANNELS", "").split(",") if x.strip()] or "its own routing"}}
    c = {}
    if env.get("COURIER_AUTH_TOKEN") and env.get("COURIER_TO"):
        c["courier"] = {"ready": True, "channels": [x for x in env.get("COURIER_CHANNELS", "").split(",") if x.strip() and x.strip().lower() not in NO_PHONE_CHANNELS] or "its own routing"}
    if env.get("APPRISE_URL") and (env.get("APPRISE_KEY") or env.get("APPRISE_URLS")):
        c["apprise"] = {"ready": True, "mode": "saved key" if env.get("APPRISE_KEY") else "urls from settings"}
    if env.get("TESTOPS_PUSH_URL"):
        c["testops-mobile"] = {"ready": True}
    tw = env.get("WHATSAPP_PROVIDER") == "twilio" and all(env.get(k) for k in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"))
    if env.get("WHATSAPP_TO") and (tw or (env.get("WHATSAPP_PROVIDER") != "twilio" and env.get("WHATSAPP_TOKEN") and env.get("WHATSAPP_PHONE_ID"))):
        c["whatsapp"] = {"ready": True, "provider": "twilio" if tw else "meta", "to": len([x for x in env["WHATSAPP_TO"].split(",") if x.strip()]), "template": bool(env.get("TWILIO_CONTENT_SID") if tw else env.get("WHATSAPP_TEMPLATE"))}
    if env.get("SLACK_WEBHOOK_URL") or (env.get("SLACK_BOT_TOKEN") and env.get("SLACK_CHANNEL")):
        c["slack"] = {"ready": True, "via": "webhook" if env.get("SLACK_WEBHOOK_URL") else "bot"}
    if env.get("TEAMS_WEBHOOK_URL"):
        c["teams"] = {"ready": True}
    if env.get("TELEGRAM_BOT_TOKEN") and env.get("TELEGRAM_CHAT_ID"):
        c["telegram"] = {"ready": True}
    if env.get("DISCORD_WEBHOOK_URL"):
        c["discord"] = {"ready": True}
    if env.get("GOOGLE_CHAT_WEBHOOK_URL"):
        c["google-chat"] = {"ready": True}
    if env.get("SMTP_HOST") and env.get("SMTP_FROM") and env.get("EMAIL_TO"):
        c["email"] = {"ready": True, "to": len([x for x in env["EMAIL_TO"].split(",") if x.strip()])}
    if env.get("NTFY_URL"):
        c["ntfy"] = {"ready": True}
    if env.get("NOTIFY_WEBHOOK_URL"):
        c["webhook"] = {"ready": True, "signed": bool(env.get("NOTIFY_WEBHOOK_SECRET"))}
    return c


# ---- routes: which events go to which channel, from what severity
def _routes_path(env):
    return os.path.join(env.get("PHOENIX_DATA_DIR", "."), "notify-routes.json")


def routes(env):
    try:
        r = json.load(open(_routes_path(env)))
        return r if isinstance(r, dict) else {}
    except Exception:
        return {}


def set_routes(env, new):
    """new = {channel: {events?: [...], min?: info|warn|error, off?: bool}}. Unknown channels, events and levels are refused, not ignored."""
    if not isinstance(new, dict):
        raise ValueError("routes must be an object")
    out = {}
    for ch, r in new.items():
        if ch not in ALL or not isinstance(r, dict):
            raise ValueError(f"unknown channel '{ch}'")
        evs = r.get("events")
        if evs is not None and (not isinstance(evs, list) or any(e not in EVENTS for e in evs)):
            raise ValueError(f"events for {ch} must come from: {', '.join(EVENTS)}")
        if r.get("min") is not None and r["min"] not in SEVERITY:
            raise ValueError("min is info, warn or error")
        out[ch] = {k: r[k] for k in ("events", "min", "off") if k in r}
    os.makedirs(os.path.dirname(os.path.abspath(_routes_path(env))), exist_ok=True)
    json.dump(out, open(_routes_path(env), "w"), indent=1)
    return out


def wanted(ch, event, severity, env):
    r = routes(env).get(ch) or {}
    if ch == "email" and (event in HIGH_VOLUME or event == "digest") and event not in (r.get("events") or []):
        return False                                   # no flood of emails: a channel with a phone's attention (WhatsApp, Teams, the app) gets the digest
    if r.get("off"):
        return False
    if r.get("events") is not None and event not in r["events"]:
        return False
    return SEVERITY[severity] >= SEVERITY[r.get("min", env.get("PHOENIX_NOTIFY_MIN", "info"))]


# ---- one sender per platform: (env, title, body, link, fetch) -> (ok, detail)
async def _post(fetch, url, payload, headers=None, raw=None):
    st, text = await fetch("POST", url, {"Content-Type": "application/json", **(headers or {})}, raw if raw is not None else json.dumps(payload))
    return st, text


def _line(title, body, link):
    return f"*{title}*\n{body}" + (f"\n{link}" if link else "")


async def _slack(env, title, body, link, fetch):
    if env.get("SLACK_WEBHOOK_URL"):
        if not _https(env["SLACK_WEBHOOK_URL"], "slack"):
            return False, "SLACK_WEBHOOK_URL must be an https://hooks.slack.com address"
        st, t = await _post(fetch, env["SLACK_WEBHOOK_URL"], {"text": _line(title, body, link)[:3500]})
        return st < 300, f"HTTP {st}"
    st, t = await _post(fetch, "https://slack.com/api/chat.postMessage", {"channel": env["SLACK_CHANNEL"], "text": _line(title, body, link)[:3500]}, {"Authorization": f"Bearer {env['SLACK_BOT_TOKEN']}"})
    try:
        j = json.loads(t or "{}")
    except Exception:
        j = {}
    return st < 300 and j.get("ok") is True, "ok" if j.get("ok") else f"Slack said: {str(j.get('error', st))[:60]}"


async def _teams(env, title, body, link, fetch):
    if not _https(env["TEAMS_WEBHOOK_URL"], "teams"):
        return False, "TEAMS_WEBHOOK_URL must be a Teams Workflows (Power Automate) or Office 365 webhook address"
    card = {"type": "AdaptiveCard", "$schema": "http://adaptivecards.io/schemas/adaptive-card.json", "version": "1.4",
            "body": [{"type": "TextBlock", "text": title, "weight": "Bolder", "size": "Medium", "wrap": True}, {"type": "TextBlock", "text": body, "wrap": True}],
            **({"actions": [{"type": "Action.OpenUrl", "title": "Open", "url": link}]} if link and _https(link) else {})}
    st, _ = await _post(fetch, env["TEAMS_WEBHOOK_URL"], {"type": "message", "attachments": [{"contentType": "application/vnd.microsoft.card.adaptive", "contentUrl": None, "content": card}]})
    return st < 300, f"HTTP {st}"


async def _discord(env, title, body, link, fetch):
    if not _https(env["DISCORD_WEBHOOK_URL"], "discord"):
        return False, "DISCORD_WEBHOOK_URL must be a discord.com webhook address"
    st, _ = await _post(fetch, env["DISCORD_WEBHOOK_URL"], {"content": _line(title, body, link)[:1900]})
    return st < 300, f"HTTP {st}"


async def _gchat(env, title, body, link, fetch):
    if not _https(env["GOOGLE_CHAT_WEBHOOK_URL"], "google-chat"):
        return False, "GOOGLE_CHAT_WEBHOOK_URL must be a chat.googleapis.com address"
    st, _ = await _post(fetch, env["GOOGLE_CHAT_WEBHOOK_URL"], {"text": _line(title, body, link)[:3900]})
    return st < 300, f"HTTP {st}"


async def _telegram(env, title, body, link, fetch):
    st, _ = await _post(fetch, f"https://api.telegram.org/bot{env['TELEGRAM_BOT_TOKEN']}/sendMessage", {"chat_id": env["TELEGRAM_CHAT_ID"], "text": f"{title}\n{body}" + (f"\n{link}" if link else ""), "disable_web_page_preview": True})
    return st < 300, f"HTTP {st}"


async def _ntfy(env, title, body, link, fetch):
    if not _https(env["NTFY_URL"]):
        return False, "NTFY_URL must be https"
    st, _ = await fetch("POST", env["NTFY_URL"], {"Title": re.sub(r"[^\x20-\x7e]", "?", title)[:100], **({"Authorization": f"Bearer {env['NTFY_TOKEN']}"} if env.get("NTFY_TOKEN") else {}), **({"Click": link} if link else {})}, body.encode())
    return st < 300, f"HTTP {st}"


async def _webhook(env, title, body, link, fetch, event="", project="", severity="info"):
    if not _https(env["NOTIFY_WEBHOOK_URL"]):
        return False, "NOTIFY_WEBHOOK_URL must be https"
    raw = json.dumps({"event": event, "severity": severity, "title": title, "body": body, "project": project, "link": link, "at": int(time.time())})
    h = {"X-Phoenix-Signature": "sha256=" + hmac.new(env["NOTIFY_WEBHOOK_SECRET"].encode(), raw.encode(), hashlib.sha256).hexdigest()} if env.get("NOTIFY_WEBHOOK_SECRET") else {}
    st, _ = await _post(fetch, env["NOTIFY_WEBHOOK_URL"], None, h, raw)
    return st < 300, f"HTTP {st}"


async def _mobile(env, title, body, link, fetch, event="", project="", severity="info", user=""):
    if not _https(env["TESTOPS_PUSH_URL"]):
        return False, "TESTOPS_PUSH_URL must be https"
    st, _ = await _post(fetch, env["TESTOPS_PUSH_URL"], {"event": event, "severity": severity, "title": title, "body": body, "project": project, "link": link, **({"user": user} if user else {})}, {"Authorization": f"Bearer {env['TESTOPS_PUSH_TOKEN']}"} if env.get("TESTOPS_PUSH_TOKEN") else {})
    return st < 300, f"HTTP {st}"


async def _twilio_whatsapp(env, text, fetch):
    """Twilio: one form POST per person. A sandbox works within minutes (the person joins with a code); production needs a registered sender. Templates go by TWILIO_CONTENT_SID."""
    import base64
    from urllib.parse import quote, urlencode
    bad = []
    for to in [x.strip().lstrip("+") for x in env["WHATSAPP_TO"].split(",") if x.strip()]:
        form = {"From": "whatsapp:" + env["TWILIO_WHATSAPP_FROM"].lstrip("whatsapp:").strip(), "To": f"whatsapp:+{to}"}
        if env.get("TWILIO_CONTENT_SID"):
            form.update({"ContentSid": env["TWILIO_CONTENT_SID"], "ContentVariables": json.dumps({"1": text.replace("\n", " ")})})
        else:
            form["Body"] = text
        auth = base64.b64encode(f"{env['TWILIO_ACCOUNT_SID']}:{env['TWILIO_AUTH_TOKEN']}".encode()).decode()
        if env.get("PHOENIX_PUBLIC_URL") and _https(env["PHOENIX_PUBLIC_URL"]):
            form["StatusCallback"] = env["PHOENIX_PUBLIC_URL"].rstrip("/") + "/api/notify/twilio/status"
        st, t = await fetch("POST", f"https://api.twilio.com/2010-04-01/Accounts/{quote(env['TWILIO_ACCOUNT_SID'], safe='')}/Messages.json", {"Authorization": f"Basic {auth}", "Content-Type": "application/x-www-form-urlencoded"}, urlencode(form))
        if st >= 300:
            bad.append(f"HTTP {st} for ...{to[-4:]}" + (f" (Twilio code {_twilio_code(t)})" if _twilio_code(t) else ""))
        else:
            _sids[_sid(t)] = {"to": to[-4:], "at": time.time()}
    return not bad, "; ".join(bad) or "sent"


def _twilio_code(t):
    try:
        return json.loads(t or "{}").get("code") or ""
    except Exception:
        return ""


def _sid(t):
    try:
        return str(json.loads(t or "{}").get("sid") or "")
    except Exception:
        return ""


# ---- Twilio calls US: the signature proves it was Twilio, then delivery status and STOP / START replies are handled
def twilio_signature(token, url, params):
    import base64
    data = url + "".join(f"{k}{params[k]}" for k in sorted(params))
    return base64.b64encode(hmac.new(token.encode(), data.encode(), hashlib.sha1).digest()).decode()


def verify_twilio(env, path, params, signature):
    """False unless PHOENIX_PUBLIC_URL and TWILIO_AUTH_TOKEN are set AND the signature matches the exact public address Twilio was given."""
    if not (env.get("TWILIO_AUTH_TOKEN") and env.get("PHOENIX_PUBLIC_URL") and signature):
        return False
    return hmac.compare_digest(twilio_signature(env["TWILIO_AUTH_TOKEN"], env["PHOENIX_PUBLIC_URL"].rstrip("/") + path, params), signature)


def twilio_status(params):
    """Delivery receipt: queued, sent, delivered, read, undelivered, failed. Updates the delivery log so 'did it reach them' has a real answer."""
    sid, st = params.get("MessageSid", ""), params.get("MessageStatus", "")
    hit = _sids.get(sid)
    for e in reversed(_log):
        if hit and e["channel"].startswith("whatsapp") and e.get("detail", "").startswith("sent") and not e.get("final"):
            e["detail"] = f"{st}" + (f" (Twilio code {params['ErrorCode']})" if params.get("ErrorCode") else "")
            e["ok"] = st not in ("undelivered", "failed")
            e["final"] = st in ("delivered", "read", "undelivered", "failed")
            break
    return {"sid": sid, "status": st, "known": bool(hit)}


def twilio_inbound(env, params):
    """A reply on WhatsApp. STOP / UNSUBSCRIBE / CANCEL switches that number's WhatsApp off; START / YES switches it on. Anything else is only counted, never acted on."""
    text = str(params.get("Body", "")).strip().upper()
    num = re.sub(r"^whatsapp:", "", str(params.get("From", ""))).strip()
    who = next((w for w, p in prefs(env).items() if p.get("whatsappNumber") and re.sub(r"\D", "", p["whatsappNumber"]) == re.sub(r"\D", "", num)), None)
    if text in ("STOP", "UNSUBSCRIBE", "CANCEL", "END") and who:
        set_prefs(env, who, {"whatsapp": False})
        return {"action": "opted-out", "who": who}
    if text in ("START", "YES", "UNSTOP") and who:
        set_prefs(env, who, {"whatsapp": True})
        return {"action": "opted-in", "who": who}
    return {"action": "none", "known": bool(who)}


_sids = {}



async def _whatsapp(env, title, body, link, fetch):
    text = f"{title}\n{body}"[:1000]
    if env.get("WHATSAPP_PROVIDER") == "twilio":
        return await _twilio_whatsapp(env, text, fetch)
    bad = []
    for to in [x.strip().lstrip("+") for x in env["WHATSAPP_TO"].split(",") if x.strip()]:
        payload = ({"messaging_product": "whatsapp", "to": to, "type": "template", "template": {"name": env["WHATSAPP_TEMPLATE"], "language": {"code": env.get("WHATSAPP_LANG", "en")}, "components": [{"type": "body", "parameters": [{"type": "text", "text": text.replace("\n", " ")}]}]}}
                   if env.get("WHATSAPP_TEMPLATE") else {"messaging_product": "whatsapp", "to": to, "type": "text", "text": {"body": text}})
        st, _ = await _post(fetch, f"https://graph.facebook.com/v20.0/{env['WHATSAPP_PHONE_ID']}/messages", payload, {"Authorization": f"Bearer {env['WHATSAPP_TOKEN']}"})
        if st >= 300:
            bad.append(f"HTTP {st} for ...{to[-4:]}")
    return not bad, "; ".join(bad) or "sent"


async def _email(env, title, body, link, fetch):
    m = EmailMessage()
    m["Subject"], m["From"], m["To"] = re.sub(r"[\r\n]", " ", title)[:150], env["SMTP_FROM"], ", ".join(x.strip() for x in env["EMAIL_TO"].split(",") if x.strip())
    m.set_content(body + (f"\n\n{link}" if link else ""))

    def go():
        with smtplib.SMTP(env["SMTP_HOST"], int(env.get("SMTP_PORT", 587)), timeout=20) as s:
            s.starttls()
            if env.get("SMTP_USER"):
                s.login(env["SMTP_USER"], env.get("SMTP_PASS", ""))
            s.send_message(m)
    await asyncio.to_thread(go)
    return True, "sent"


# Schemes that send SMS or place calls: refused when Phoenix itself hands them to Apprise. (Anything already saved INSIDE the Apprise container is outside Phoenix's sight: keep those out too.)
NO_PHONE_SCHEMES = {"twilio", "sns", "nexmo", "vonage", "clicksend", "d7sms", "bulksms", "bulkvs", "kavenegar", "messagebird", "msg91", "plivo", "popcorn", "sinch", "smseagle", "smsmanager", "techuld", "voipms",
                    "burstsms", "46elks", "httpsms", "africas", "sfr", "seven", "smpp", "textmagic", "signal", "call", "voice", "sms", "mmost-sms"}


def _apprise_urls_ok(urls):
    bad = [u for u in urls if re.match(r"^([\w+-]+)://", u.strip()) and re.match(r"^([\w+-]+)://", u.strip()).group(1).split("+")[0].lower() in NO_PHONE_SCHEMES]
    return not bad, bad


async def _apprise(env, title, body, link, fetch, severity="info", **_):
    """Self-hosted: the open source Apprise API runs as its own container and reaches 100+ services (WhatsApp, Slack, Teams, email, Telegram, Discord, ntfy...). Phoenix sends one JSON call.
    APPRISE_URL=http://apprise:8000 plus EITHER APPRISE_KEY (a config saved in the container) OR APPRISE_URLS (comma list of Apprise URLs held in Phoenix's settings; SMS and voice schemes are refused)."""
    base = env["APPRISE_URL"].rstrip("/")
    if not (_internal(base) or _https(base)):
        return False, "APPRISE_URL must be https, or http to a container on this network"
    payload = {"title": title[:200], "body": body + (f"\n{link}" if link else ""), "type": {"info": "info", "warn": "warning", "error": "failure"}.get(severity, "info"), "format": "text"}
    if env.get("APPRISE_KEY"):
        url = f"{base}/notify/{re.sub(r'[^\w.-]', '', env['APPRISE_KEY'])}"
        if env.get("APPRISE_TAG"):
            payload["tag"] = env["APPRISE_TAG"]
    else:
        urls = [u.strip() for u in env.get("APPRISE_URLS", "").split(",") if u.strip()]
        ok, bad = _apprise_urls_ok(urls)
        if not ok:
            return False, f"SMS and call services are not allowed: {', '.join(b.split('://')[0] for b in bad)}"
        url, payload["urls"] = f"{base}/notify", ",".join(urls)
    st, _t = await _post(fetch, url, payload)
    return st < 300, f"HTTP {st}"


def _courier_body(env, title, body, link, to):
    to = dict(to or {})
    msg = {"to": to, "content": {"title": title[:150], "body": body + (f"\n{link}" if link else "")}}
    chans = [x.strip() for x in env.get("COURIER_CHANNELS", "").split(",") if x.strip() and x.strip().lower() not in NO_PHONE_CHANNELS]
    if (to or {}).get("phone_number") and not chans:
        to = {k: v for k, v in to.items() if k != "phone_number"}        # a phone number with no named channel would let Courier choose SMS: never
        msg["to"] = to
    if chans:
        msg["routing"] = {"method": "all", "channels": chans}      # e.g. whatsapp,slack,email: every one of them, not the first that works
    return {"message": msg}


async def _courier(env, title, body, link, fetch):
    """One third-party API for everything: Courier sends to WhatsApp, Slack, Teams, email and push from one call; the channels and their providers are set up in Courier's own console.
    COURIER_TO is a Courier recipient as JSON ({"user_id":"ops"}, {"list_id":"phoenix-ops"} or {"email":"a@b.com","phone_number":"+65..."}). Message texts are masked first, like every channel."""
    try:
        to = json.loads(env.get("COURIER_TO") or "{}")
    except Exception:
        return False, "COURIER_TO must be JSON, e.g. {\"list_id\": \"phoenix-ops\"}"
    if not isinstance(to, dict) or not to:
        return False, "COURIER_TO is empty: say who receives it"
    st, t = await _post(fetch, "https://api.courier.com/send", _courier_body(env, title, body, link, to), {"Authorization": f"Bearer {env['COURIER_AUTH_TOKEN']}"})
    try:
        rid = json.loads(t or "{}").get("requestId", "")
    except Exception:
        rid = ""
    return st < 300, f"HTTP {st}" + (f" request {rid}" if rid else "")


SENDERS = {"apprise": _apprise, "courier": _courier, "testops-mobile": _mobile, "whatsapp": _whatsapp, "slack": _slack, "teams": _teams, "telegram": _telegram, "discord": _discord, "google-chat": _gchat, "email": _email, "ntfy": _ntfy, "webhook": _webhook}
ALL = tuple(SENDERS)
_EXTRA = ("testops-mobile", "webhook", "apprise")      # these two also get the event name, project and severity as fields


# ---- people: the TestOps login is Microsoft (Entra ID), so a person's name, mail and mobile come from the directory (Graph); they choose what reaches them
def _prefs_path(env):
    return os.path.join(env.get("PHOENIX_DATA_DIR", "."), "notify-people.json")


def prefs(env, who=None):
    try:
        d = json.load(open(_prefs_path(env)))
    except Exception:
        d = {}
    return (d.get(str(who).lower(), {}) if who else d)


def personal_phone_allowed(env):
    """Off by default. A person's own mobile number is personal data (PDPA): Phoenix keeps one only when the organisation has switched this on AND the person typed it in themselves."""
    return str(env.get("NOTIFY_PERSONAL_PHONE", "")).lower() == "allow"


def mask_number(n):
    d = re.sub(r"\D", "", str(n or ""))
    return ("+" + "*" * max(len(d) - 4, 0) + d[-4:]) if d else ""


def public_prefs(env, who):
    p = dict(prefs(env, who))
    if p.get("whatsappNumber"):
        p["whatsappNumber"] = mask_number(p["whatsappNumber"])
    return p


def erase_prefs(env, who):
    """The person withdraws: everything Phoenix holds about their notification choices (including any number) is deleted."""
    allp = prefs(env)
    gone = allp.pop(str(who).strip().lower(), None) is not None
    json.dump(allp, open(_prefs_path(env), "w"), indent=1)
    return gone


def set_prefs(env, who, new):
    """A person sets their OWN: {email: bool, whatsapp: bool (opt-in), whatsappNumber?: '+65...', min: info|warn|error, off: bool}."""
    who = str(who).strip().lower()
    if "@" not in who:
        raise ValueError("a person is their sign-in address")
    clean = {}
    for k in ("email", "whatsapp", "off"):
        if k in new:
            clean[k] = bool(new[k])
    if new.get("min") in SEVERITY:
        clean["min"] = new["min"]
    if (new.get("whatsappNumber") or new.get("whatsapp") is True) and not personal_phone_allowed(env):
        raise ValueError("personal phone numbers are turned off by your organisation: use Teams, the TestOps app or email")
    if new.get("whatsapp") is True and not (new.get("whatsappNumber") or prefs(env, who).get("whatsappNumber")):
        raise ValueError("to get WhatsApp, give your own number (whatsappNumber): it is used only to send you Phoenix alerts, and you can delete it any time")
    if new.get("whatsappNumber"):
        clean["consentAt"] = int(time.time())
        n = re.sub(r"[\s()-]", "", str(new["whatsappNumber"]))
        if not re.fullmatch(r"\+?\d{8,15}", n):
            raise ValueError("whatsappNumber looks like +6591234567")
        clean["whatsappNumber"] = n
    allp = prefs(env)
    allp[who] = {**allp.get(who, {}), **clean}
    os.makedirs(os.path.dirname(os.path.abspath(_prefs_path(env))), exist_ok=True)
    json.dump(allp, open(_prefs_path(env), "w"), indent=1)
    return allp[who]


_dir_cache = {}


async def directory(upn, env, fetch=_http.fetch):
    """{name, mail} for a sign-in address (the mobile number is deliberately NOT read: PDPA data minimisation) from Microsoft Graph (needs MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET; read-only User.Read.All). None when not set up or not found."""
    if not all(env.get(k) for k in ("MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET")):
        return None
    hit = _dir_cache.get(upn.lower())
    if hit and time.time() - hit[0] < 600:
        return hit[1]
    from urllib.parse import quote, urlencode
    try:
        st, t = await fetch("POST", f"https://login.microsoftonline.com/{quote(env['MS_TENANT_ID'], safe='')}/oauth2/v2.0/token", {"Content-Type": "application/x-www-form-urlencoded"},
                            urlencode({"client_id": env["MS_CLIENT_ID"], "client_secret": env["MS_CLIENT_SECRET"], "scope": "https://graph.microsoft.com/.default", "grant_type": "client_credentials"}))
        tok = json.loads(t or "{}").get("access_token") if st == 200 else None
        if not tok:
            return None
        st, t = await fetch("GET", f"https://graph.microsoft.com/v1.0/users/{quote(upn, safe='@')}?$select=displayName,mail,userPrincipalName", {"Authorization": f"Bearer {tok}"}, None)
        u = json.loads(t or "{}") if st == 200 else None
    except Exception:
        return None
    out = {"name": u.get("displayName", ""), "mail": u.get("mail") or u.get("userPrincipalName") or "", "token": tok} if u else None
    _dir_cache[upn.lower()] = (time.time(), out)
    return out


async def _teams_user(env, tok, upn, title, body, link, fetch):
    """Teams activity-feed notification to one person (Graph sendActivityNotification). Needs the Phoenix Teams app (id MS_TEAMS_APP_ID) installed for them and the TeamsActivity.Send permission; its manifest must declare the activity type `phoenixAlert`."""
    from urllib.parse import quote
    st, _ = await fetch("POST", f"https://graph.microsoft.com/v1.0/users/{quote(upn, safe='@')}/teamwork/sendActivityNotification", {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
                        json.dumps({"topic": {"source": "text", "value": "Phoenix", "webUrl": link if _https(link) else env.get("PHOENIX_PUBLIC_URL", "https://teams.microsoft.com")}, "activityType": "phoenixAlert",
                                    "previewText": {"content": body[:150]}, "templateParameters": [{"name": "alert", "value": title[:100]}]}))
    return st < 300, f"HTTP {st}"


async def _graph_mail(env, tok, sender, to, title, body, fetch):
    from urllib.parse import quote
    st, _ = await fetch("POST", f"https://graph.microsoft.com/v1.0/users/{quote(sender, safe='@')}/sendMail", {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
                        json.dumps({"message": {"subject": title[:150], "body": {"contentType": "Text", "content": body}, "toRecipients": [{"emailAddress": {"address": to}}]}, "saveToSentItems": False}))
    return st < 300, f"HTTP {st}"


async def _to_person(who, event, sev, title, body, link, env, fetch, sleep):
    p, out = prefs(env, who), {}
    if p.get("off") or SEVERITY[sev] < SEVERITY[p.get("min", "info")]:
        return {"person": {"ok": True, "detail": "this person turned notifications off or set a higher level"}}
    d = await directory(who, env, fetch)
    if _via_courier(env):                                   # one call: Courier chooses the channels; the phone is added only for people who opted in to WhatsApp
        to = {"email": (d or {}).get("mail") or who}
        num = p.get("whatsappNumber") if personal_phone_allowed(env) else None
        if p.get("whatsapp") is True and num:
            to["phone_number"] = num
        try:
            ok, det = await _post_courier_person(env, title, body, link, to, fetch)
        except Exception as e:
            ok, det = False, str(e)[:100]
        return {"courier": {"ok": ok, "detail": det}}
    text = body + (f"\n{link}" if link else "")
    if p.get("email", True):
        addr = (d or {}).get("mail") or who
        try:
            if d and env.get("MS_MAIL_SENDER"):
                out["email"] = dict(zip(("ok", "detail"), await _graph_mail(env, d["token"], env["MS_MAIL_SENDER"], addr, title, text, fetch)))
            elif env.get("SMTP_HOST") and env.get("SMTP_FROM"):
                ok, det = await _email({**env, "EMAIL_TO": addr}, title, body, link, fetch)
                out["email"] = {"ok": ok, "detail": det}
        except Exception as e:
            out["email"] = {"ok": False, "detail": str(e)[:100]}
    if env.get("TESTOPS_PUSH_URL"):                          # the TestOps app: addressed by sign-in, never by phone number
        try:
            ok, det = await _mobile({**env}, title, body, link, fetch, event=event, project="", severity=sev, user=who)
            out["testops-mobile"] = {"ok": ok, "detail": det}
        except Exception as e:
            out["testops-mobile"] = {"ok": False, "detail": str(e)[:100]}
    if d and env.get("MS_TEAMS_APP_ID"):                     # Teams activity feed: shows in the Teams app on their phone and desktop, no number involved
        try:
            ok, det = await _teams_user(env, d["token"], who, title, body, link, fetch)
            out["teams"] = {"ok": ok, "detail": det}
        except Exception as e:
            out["teams"] = {"ok": False, "detail": str(e)[:100]}
    if p.get("whatsapp") is True and personal_phone_allowed(env) and channels({**env, "WHATSAPP_TO": "+0"}).get("whatsapp") and p.get("whatsappNumber"):   # only a number the person typed in themselves
        try:
            ok, det = await _whatsapp({**env, "WHATSAPP_TO": p["whatsappNumber"]}, title, body, link, fetch)
            out["whatsapp"] = {"ok": ok, "detail": det}
        except Exception as e:
            out["whatsapp"] = {"ok": False, "detail": str(e)[:100]}
    return out or {"person": {"ok": False, "detail": "no way to reach this person: set up email, the TestOps app or the Teams app"}}


async def _post_courier_person(env, title, body, link, to, fetch):
    st, _ = await _post(fetch, "https://api.courier.com/send", _courier_body(env, title, body, link, to), {"Authorization": f"Bearer {env['COURIER_AUTH_TOKEN']}"})
    return st < 300, f"HTTP {st}"


# ---- digest: defects raised and executions failed are counted, then sent as one short message every NOTIFY_DIGEST_MINUTES (default 15)
_buf, _lock = {}, threading.Lock()
_flusher = {"started": False}
NAMES = {"defect-raised": "defect(s) raised", "execution-failed": "execution(s) failed"}


def collect(kind, project, detail, env, start=True):
    """Count one high-volume event. Never blocks and never raises. The first call starts the background sender."""
    if kind not in HIGH_VOLUME:
        return False
    with _lock:
        b = _buf.setdefault(project or "-", {}).setdefault(kind, {"n": 0, "samples": []})
        b["n"] += 1
        if len(b["samples"]) < 5 and detail:
            b["samples"].append(logmask.mask(str(detail), 80))
    if start and not _flusher["started"] and channels(env):
        _flusher["started"] = True
        threading.Thread(target=_loop, args=(env,), daemon=True).start()
    return True


def digest_message(snapshot, minutes):
    total = {k: sum(p.get(k, {}).get("n", 0) for p in snapshot.values()) for k in HIGH_VOLUME}
    lines = []
    for proj, kinds in sorted(snapshot.items(), key=lambda x: -sum(v["n"] for v in x[1].values()))[:6]:
        lines.append(f"{proj}: " + ", ".join(f"{v['n']} {NAMES[k]}" for k, v in kinds.items()) + ((" (e.g. " + "; ".join(next(iter(kinds.values()))["samples"][:2]) + ")") if next(iter(kinds.values()))["samples"] else ""))
    head = f"Last {minutes} min: " + ", ".join(f"{total[k]} {NAMES[k]}" for k in ("defect-raised", "execution-failed") if total[k])
    return head, "\n".join(lines) + (f"\n(+{len(snapshot) - 6} more projects)" if len(snapshot) > 6 else "")


async def flush_digest(env, fetch=_http.fetch, minutes=None, **kw):
    """Send what has been counted as ONE message and clear the counters. Nothing counted: nothing sent."""
    with _lock:
        snap = {pj: dict(k) for pj, k in _buf.items() if k}
        _buf.clear()
    if not snap:
        return {}
    minutes = minutes or int(env.get("NOTIFY_DIGEST_MINUTES", 15) or 15)
    head, body = digest_message(snap, minutes)
    return await send("digest", head, body, env, fetch=fetch, force=False, **kw)


def _loop(env):
    every = max(1, int(env.get("NOTIFY_DIGEST_MINUTES", 15) or 15)) * 60
    while True:
        time.sleep(every)
        try:
            asyncio.run(flush_digest(env))
        except Exception:  # noqa: BLE001  the digest never takes the platform down
            pass


def recent(n=50):
    return list(_log)[-n:][::-1]


async def send(event, title, body, env, project="", link="", fetch=_http.fetch, severity=None, only=None, sleep=asyncio.sleep, force=False, to=None):
    """-> {channel: {ok, detail}} for the channels that were tried. `only` limits to some channels (used by the test button). `force` skips routing and the 60 s repeat guard."""
    sev = severity if severity in SEVERITY else EVENTS.get(event, "info")
    title, body = logmask.mask(str(title), 120), logmask.mask(str(body), 900)
    link = str(link or "")[:300] if _https(link) else ""
    ready, res = channels(env), {}
    to = [t for t in (to or []) if isinstance(t, str) and "@" in t][:20]
    key = hashlib.sha256(f"{event}|{title}|{body}|{project}".encode()).hexdigest()
    now = time.time()
    if ready and not force and now - _recent.get(key, 0) < 60 and not to:
        return {"skipped": {"ok": True, "detail": "the same message was sent in the last minute"}}
    for k in [k for k, t in _recent.items() if now - t > 120]:
        _recent.pop(k, None)
    for ch in ready:
        if (only and ch not in only) or (not force and not wanted(ch, event, sev, env)):
            continue
        extra = {"event": event, "project": project, "severity": sev} if ch in _EXTRA else {}
        ok, detail = False, ""
        for attempt in (1, 2):
            try:
                ok, detail = await SENDERS[ch](env, title, body, link, fetch, **extra)
            except Exception as e:
                ok, detail = False, re.sub(r"(bot|token=|Bearer )[\w:.-]+", r"\1[masked]", str(e))[:120]
            if ok or ("HTTP 4" in detail and "HTTP 429" not in detail):
                break
            if attempt == 1:
                await sleep(1.5)
        res[ch] = {"ok": ok, "detail": detail}
        _log.append({"at": int(now), "event": event, "severity": sev, "channel": ch, "ok": ok, "detail": detail[:120], "title": title[:80]})
    for who in to:                                   # people named by the caller (who started the run, who must sign off): from the Microsoft directory and their own choices
        for ch, r in (await _to_person(who, event, sev, title, body, link, env, fetch, sleep)).items():
            res[f"{ch}:{who}"] = r
            _log.append({"at": int(now), "event": event, "severity": sev, "channel": f"{ch}:{who}", "ok": r["ok"], "detail": r["detail"][:120], "title": title[:80]})
    if res:
        _recent[key] = now
    try:
        from . import logstore
        for ch, r in res.items():
            logstore.record("agent_event", {"project": project, "run": "", "agent": "notify", "event": f"{event}>{ch}", "status": "ok" if r["ok"] else "failed", "ms": 0, "detail": title[:200]}, env)
        if not res:
            logstore.record("agent_event", {"project": project, "run": "", "agent": "notify", "event": event, "status": "no-channel" if not ready else "not-routed", "ms": 0, "detail": title[:200]}, env)
    except Exception:  # noqa: BLE001
        pass
    return res
