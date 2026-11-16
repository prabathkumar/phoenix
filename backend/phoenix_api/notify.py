"""Notifications to the tester's phone: the TestOps mobile app and WhatsApp. Nothing here ever raises; a channel that is not set up is reported, not guessed.
  TestOps mobile app: POST TESTOPS_PUSH_URL  {event, title, body, project, link}  with  Authorization: Bearer TESTOPS_PUSH_TOKEN   (the app's push contract; see docs/NOTIFICATIONS.md)
  WhatsApp (Meta Cloud API): WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_TO (comma list, international format). Free text works inside WhatsApp's 24-hour window;
  set WHATSAPP_TEMPLATE (an approved template with one body variable) to message outside it.
Texts are masked (logmask) and cut short before they leave."""
import json

from . import http as _http, logmask

EVENTS = ("upgrade-blocked", "upgrade-promoted", "upgrade-rolled-back", "scan-finding", "run-result", "needs-you", "test")


def channels(env):
    out = {}
    if env.get("TESTOPS_PUSH_URL"):
        out["testops-mobile"] = {"ready": True}
    if env.get("WHATSAPP_TOKEN") and env.get("WHATSAPP_PHONE_ID") and env.get("WHATSAPP_TO"):
        out["whatsapp"] = {"ready": True, "to": len([x for x in env["WHATSAPP_TO"].split(",") if x.strip()]), "template": bool(env.get("WHATSAPP_TEMPLATE"))}
    return out


async def send(event, title, body, env, project="", link="", fetch=_http.fetch):
    """-> {channel: {ok, detail}}. Empty when no channel is set up."""
    title, body = logmask.mask(str(title), 120), logmask.mask(str(body), 900)
    res = {}
    if env.get("TESTOPS_PUSH_URL"):
        try:
            h = {"Content-Type": "application/json", **({"Authorization": f"Bearer {env['TESTOPS_PUSH_TOKEN']}"} if env.get("TESTOPS_PUSH_TOKEN") else {})}
            st, _ = await fetch("POST", env["TESTOPS_PUSH_URL"], h, json.dumps({"event": event, "title": title, "body": body, "project": project, "link": link}))
            res["testops-mobile"] = {"ok": st < 300, "detail": f"HTTP {st}"}
        except Exception as e:
            res["testops-mobile"] = {"ok": False, "detail": str(e)[:120]}
    if env.get("WHATSAPP_TOKEN") and env.get("WHATSAPP_PHONE_ID") and env.get("WHATSAPP_TO"):
        text = f"{title}\n{body}"[:1000]
        for to in [x.strip().lstrip("+") for x in env["WHATSAPP_TO"].split(",") if x.strip()]:
            payload = ({"messaging_product": "whatsapp", "to": to, "type": "template", "template": {"name": env["WHATSAPP_TEMPLATE"], "language": {"code": env.get("WHATSAPP_LANG", "en")}, "components": [{"type": "body", "parameters": [{"type": "text", "text": text.replace("\n", " ")[:1000]}]}]}}
                       if env.get("WHATSAPP_TEMPLATE") else {"messaging_product": "whatsapp", "to": to, "type": "text", "text": {"body": text}})
            try:
                st, _ = await fetch("POST", f"https://graph.facebook.com/v20.0/{env['WHATSAPP_PHONE_ID']}/messages", {"Authorization": f"Bearer {env['WHATSAPP_TOKEN']}", "Content-Type": "application/json"}, json.dumps(payload))
                res.setdefault("whatsapp", {"ok": True, "detail": ""})
                if st >= 300:
                    res["whatsapp"] = {"ok": False, "detail": f"HTTP {st} for ...{to[-4:]}"}
            except Exception as e:
                res["whatsapp"] = {"ok": False, "detail": str(e)[:120]}
    try:
        from . import logstore
        logstore.record("agent_event", {"project": project, "run": "", "agent": "notify", "event": event, "status": "ok" if res and all(v["ok"] for v in res.values()) else "failed" if res else "no-channel", "ms": 0, "detail": title[:200]}, env)
    except Exception:  # noqa: BLE001
        pass
    return res
