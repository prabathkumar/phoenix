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
    tpl = asyncio.run(notify.send("test", "t2", "b2", {**env, "WHATSAPP_TEMPLATE": "alert"}, fetch=fetch))
    assert sent[-1][2]["type"] == "template" and tpl["whatsapp"]["ok"]


def test_every_platform_gets_its_own_shape_and_only_its_own_hosts(tmp_path):
    sent = []

    async def fetch(m, url, h, body):
        sent.append((m, url, h, body))
        return 200, '{"ok": true}'
    env = {"SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/T/B/x", "TEAMS_WEBHOOK_URL": "https://prod-1.westus.logic.azure.com/workflows/x", "DISCORD_WEBHOOK_URL": "https://discord.com/api/webhooks/1/x",
           "GOOGLE_CHAT_WEBHOOK_URL": "https://chat.googleapis.com/v1/spaces/x", "TELEGRAM_BOT_TOKEN": "123:abc", "TELEGRAM_CHAT_ID": "9", "NTFY_URL": "https://ntfy.sh/phoenix", "NOTIFY_WEBHOOK_URL": "https://hooks.example.com/p", "NOTIFY_WEBHOOK_SECRET": "s3",
           "PHOENIX_DATA_DIR": str(tmp_path)}
    r = asyncio.run(notify.send("upgrade-blocked", "Blocked", "details", env, link="https://phoenix.test/run/1", fetch=fetch, force=True))
    assert set(r) == {"slack", "teams", "discord", "google-chat", "telegram", "ntfy", "webhook"} and all(v["ok"] for v in r.values())
    by = {u.split("/")[2]: (u, b) for _, u, _, b in sent}
    assert "Action.OpenUrl" in by["prod-1.westus.logic.azure.com"][1] and json.loads(by["discord.com"][1])["content"].startswith("*Blocked*")
    sig = next(h for _, u, h, _ in sent if "example.com" in u)["X-Phoenix-Signature"]
    assert sig.startswith("sha256=") and len(sig) == 71
    # a look-alike host is refused, never posted to
    bad = asyncio.run(notify.send("test", "x1", "y1", {"SLACK_WEBHOOK_URL": "https://hooks.slack.com.evil.test/x"}, fetch=fetch, force=True))
    assert not bad["slack"]["ok"] and not any("evil" in s[1] for s in sent)
    assert not asyncio.run(notify.send("test", "x2", "y2", {"TEAMS_WEBHOOK_URL": "http://prod.logic.azure.com/x"}, fetch=fetch, force=True))["teams"]["ok"]


def test_routes_filter_and_unknown_things_are_refused(tmp_path):
    env = {"SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/x", "DISCORD_WEBHOOK_URL": "https://discord.com/api/webhooks/1/x", "PHOENIX_DATA_DIR": str(tmp_path)}
    notify.set_routes(env, {"slack": {"events": ["upgrade-blocked"]}, "discord": {"min": "error"}})
    sent = []

    async def fetch(m, u, h, b):
        sent.append(u)
        return 200, "{}"
    asyncio.run(notify.send("run-result", "r1", "r1", env, fetch=fetch))
    assert sent == []                                              # slack wants only blocked upgrades; discord only errors
    asyncio.run(notify.send("upgrade-blocked", "r2", "r2", env, fetch=fetch))
    assert len(sent) == 1 and "slack" in sent[0]
    asyncio.run(notify.send("upgrade-rolled-back", "r3", "r3", env, fetch=fetch))
    assert any("discord" in u for u in sent)
    for bad in ({"fax": {}}, {"slack": {"events": ["nope"]}}, {"slack": {"min": "loud"}}, "x"):
        with pytest.raises(ValueError):
            notify.set_routes(env, bad)


def test_twilio_whatsapp_and_people_from_the_microsoft_directory(tmp_path):
    sent = []

    async def fetch(m, url, h, body):
        sent.append((m, url, h, body))
        if "login.microsoftonline.com" in url:
            return 200, '{"access_token": "TOK"}'
        if "graph.microsoft.com/v1.0/users/" in url and m == "GET":
            return 200, json.dumps({"displayName": "Ann", "mail": "ann@ytl.com", "mobilePhone": "+6591234567", "userPrincipalName": "ann@ytl.com"})
        return 200, "{}"
    env = {"PHOENIX_DATA_DIR": str(tmp_path), "WHATSAPP_PROVIDER": "twilio", "TWILIO_ACCOUNT_SID": "ACx", "TWILIO_AUTH_TOKEN": "tk", "TWILIO_WHATSAPP_FROM": "+14155238886", "WHATSAPP_TO": "+6590000000",
           "MS_TENANT_ID": "t", "MS_CLIENT_ID": "c", "MS_CLIENT_SECRET": "s", "MS_MAIL_SENDER": "phoenix@ytl.com"}
    assert notify.channels(env)["whatsapp"]["provider"] == "twilio"
    r = asyncio.run(notify.send("test", "T3", "B3", env, fetch=fetch, force=True, only=["whatsapp"]))
    tw = next(x for x in sent if "api.twilio.com" in x[1])
    assert r["whatsapp"]["ok"] and "From=whatsapp%3A%2B14155238886" in tw[3] and "To=whatsapp%3A%2B6590000000" in tw[3] and tw[2]["Authorization"].startswith("Basic ")
    # a person: email by Graph always; WhatsApp only after they opt in, to the number the directory holds
    sent.clear()
    r = asyncio.run(notify.send("needs-you", "T4", "B4", env, fetch=fetch, force=True, only=["none"], to=["ann@ytl.com"]))
    assert r["email:ann@ytl.com"]["ok"] and "whatsapp:ann@ytl.com" not in r and any("/sendMail" in x[1] for x in sent)
    with pytest.raises(ValueError, match="turned off by your organisation"):
        notify.set_prefs(env, "Ann@ytl.com", {"whatsapp": True, "whatsappNumber": "+6591234567"})        # PDPA: off unless the organisation allows it
    env["NOTIFY_PERSONAL_PHONE"] = "allow"
    with pytest.raises(ValueError, match="give your own number"):
        notify.set_prefs(env, "Ann@ytl.com", {"whatsapp": True})                                          # never taken from the directory
    notify.set_prefs(env, "Ann@ytl.com", {"whatsapp": True, "whatsappNumber": "+6591234567"})
    assert notify.prefs(env, "ann@ytl.com")["consentAt"] and notify.public_prefs(env, "ann@ytl.com")["whatsappNumber"] == "+******4567"
    assert not any("mobilePhone" in x[1] for x in sent), "the directory is asked for name and mail only"
    sent.clear()
    r = asyncio.run(notify.send("needs-you", "T5", "B5", env, fetch=fetch, force=True, only=["none"], to=["ann@ytl.com"]))
    assert r["whatsapp:ann@ytl.com"]["ok"] and "To=whatsapp%3A%2B6591234567" in next(x for x in sent if "twilio" in x[1])[3]
    assert notify.erase_prefs(env, "ann@ytl.com") and notify.prefs(env, "ann@ytl.com") == {}               # withdrawal deletes everything held, the number included
    notify.set_prefs(env, "ann@ytl.com", {"off": True})
    assert "turned notifications off" in asyncio.run(notify.send("needs-you", "T6", "B6", env, fetch=fetch, force=True, only=["none"], to=["ann@ytl.com"]))["person:ann@ytl.com"]["detail"]
    for bad in ({"whatsappNumber": "call me"},):
        with pytest.raises(ValueError):
            notify.set_prefs(env, "ann@ytl.com", bad)
    with pytest.raises(ValueError):
        notify.set_prefs(env, "not-an-address", {})


def test_twilio_signature_matches_the_published_example_and_forgeries_change_nothing(tmp_path):
    p = {"CallSid": "CA1234567890ABCDE", "Caller": "+14158675310", "Digits": "1234", "From": "+14158675310", "To": "+18005551212"}
    assert notify.twilio_signature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", p) == "GvWf1cFY/Q7PnoempGyD5oXAezc="
    from fastapi.testclient import TestClient
    from phoenix_api.app import create_app
    from phoenix_api.service import Deps
    env = {"PHOENIX_DATA_DIR": str(tmp_path), "TWILIO_AUTH_TOKEN": "tk", "PHOENIX_PUBLIC_URL": "https://phoenix.example.com"}
    env["NOTIFY_PERSONAL_PHONE"] = "allow"
    notify.set_prefs(env, "ann@ytl.com", {"whatsapp": True, "whatsappNumber": "+6591234567"})
    c = TestClient(create_app(Deps(env=env)))
    form = {"From": "whatsapp:+6591234567", "Body": "stop"}
    good = notify.twilio_signature("tk", "https://phoenix.example.com/api/notify/twilio/inbound", form)
    assert c.post("/api/notify/twilio/inbound", data=form).status_code == 403                                   # no signature
    assert c.post("/api/notify/twilio/inbound", data=form, headers={"X-Twilio-Signature": "AAAA"}).status_code == 403
    assert notify.prefs(env, "ann@ytl.com")["whatsapp"] is True                                                  # forged calls changed nothing
    assert c.post("/api/notify/twilio/inbound", data=form, headers={"X-Twilio-Signature": good}).json() == {"action": "opted-out", "who": "ann@ytl.com"}
    assert notify.prefs(env, "ann@ytl.com")["whatsapp"] is False
    form2 = {"From": "whatsapp:+6591234567", "Body": "Yes"}
    sig2 = notify.twilio_signature("tk", "https://phoenix.example.com/api/notify/twilio/inbound", form2)
    assert c.post("/api/notify/twilio/inbound", data=form2, headers={"X-Twilio-Signature": sig2}).json()["action"] == "opted-in"
    form3 = {"From": "whatsapp:+6500000000", "Body": "STOP"}                                                     # a stranger cannot switch anyone off
    sig3 = notify.twilio_signature("tk", "https://phoenix.example.com/api/notify/twilio/inbound", form3)
    assert c.post("/api/notify/twilio/inbound", data=form3, headers={"X-Twilio-Signature": sig3}).json()["action"] == "none"
    assert TestClient(create_app(Deps(env={"TWILIO_AUTH_TOKEN": "tk"}))).post("/api/notify/twilio/status", data={"MessageSid": "x"}, headers={"X-Twilio-Signature": "x"}).status_code == 403   # no public URL set: closed


def test_status_receipts_update_the_log_and_there_is_no_sms(tmp_path):
    sent = []

    async def fetch(m, url, h, body):
        sent.append((url, body))
        return 201, json.dumps({"sid": "SM123"})
    env = {"PHOENIX_DATA_DIR": str(tmp_path), "WHATSAPP_PROVIDER": "twilio", "TWILIO_ACCOUNT_SID": "ACx", "TWILIO_AUTH_TOKEN": "tk", "TWILIO_WHATSAPP_FROM": "+14155238886", "WHATSAPP_TO": "+6590000000",
           "PHOENIX_PUBLIC_URL": "https://phoenix.example.com"}
    assert "sms" not in notify.channels({**env, "SMS_TO": "+6590000001", "TWILIO_SMS_FROM": "+15005550006"}), "SMS is not offered"
    r = asyncio.run(notify.send("test", "R1", "receipts", env, fetch=fetch, force=True))
    assert r["whatsapp"]["ok"] and "sms" not in r and "StatusCallback=https%3A%2F%2Fphoenix.example.com%2Fapi%2Fnotify%2Ftwilio%2Fstatus" in sent[0][1] and len(sent) == 1
    assert notify.twilio_status({"MessageSid": "SM123", "MessageStatus": "delivered"})["known"]
    assert next(e for e in notify.recent() if e["channel"] == "whatsapp")["detail"] == "delivered"
    notify.twilio_status({"MessageSid": "SM123", "MessageStatus": "failed", "ErrorCode": "63016"})
    assert not notify.twilio_status({"MessageSid": "unknown", "MessageStatus": "sent"})["known"]

    async def reject(m, url, h, body):
        return 400, json.dumps({"code": 63016, "message": "x"})
    assert "Twilio code 63016" in asyncio.run(notify.send("test", "R2", "x", env, fetch=reject, force=True, only=["whatsapp"]))["whatsapp"]["detail"]


def test_courier_is_the_one_sender_for_shared_and_personal_messages(tmp_path):
    sent = []

    async def fetch(m, url, h, body):
        sent.append((url, h, json.loads(body) if body and body.startswith("{") else body))
        return 202, '{"requestId": "req-1"}'
    env = {"PHOENIX_DATA_DIR": str(tmp_path), "NOTIFY_VIA": "courier-only", "COURIER_AUTH_TOKEN": "ck", "COURIER_TO": '{"list_id": "phoenix-ops"}', "COURIER_CHANNELS": "whatsapp,slack",
           "SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/x", "TWILIO_ACCOUNT_SID": "x"}
    assert list(notify.channels(env)) == ["courier"], "the direct channels are off while Courier is the sender"
    r = asyncio.run(notify.send("run-result", "C1", "password=hunter2hunter2 done", env, fetch=fetch))
    assert r["courier"]["ok"] and "request req-1" in r["courier"]["detail"] and len(sent) == 1
    url, h, b = sent[0]
    assert url == "https://api.courier.com/send" and h["Authorization"] == "Bearer ck" and b["message"]["to"] == {"list_id": "phoenix-ops"}
    assert b["message"]["routing"] == {"method": "all", "channels": ["whatsapp", "slack"]} and "hunter2hunter2" not in json.dumps(b)
    # a person: email always, phone only after the WhatsApp opt-in
    sent.clear()
    asyncio.run(notify.send("needs-you", "C2", "sign off", env, fetch=fetch, to=["ann@ytl.com"], only=["none"]))
    assert sent[0][2]["message"]["to"] == {"email": "ann@ytl.com"}
    env["NOTIFY_PERSONAL_PHONE"] = "allow"
    notify.set_prefs(env, "ann@ytl.com", {"whatsapp": True, "whatsappNumber": "+6591234567"})
    sent.clear()
    asyncio.run(notify.send("needs-you", "C3", "sign off", env, fetch=fetch, to=["ann@ytl.com"], only=["none"]))
    assert sent[0][2]["message"]["to"] == {"email": "ann@ytl.com", "phone_number": "+6591234567"}
    bad = asyncio.run(notify.send("test", "C4", "x", {**env, "COURIER_TO": "not json"}, fetch=fetch))
    assert not bad["courier"]["ok"] and "JSON" in bad["courier"]["detail"]
    assert set(notify.channels({k: v for k, v in env.items() if k != "NOTIFY_VIA"})) == {"courier", "slack"}, "without courier-only, the others are kept"


def test_courier_sits_beside_the_other_channels_and_never_sends_sms_or_calls(tmp_path):
    sent = []

    async def fetch(m, url, h, body):
        sent.append((url, json.loads(body)))
        return 202, "{}"
    env = {"PHOENIX_DATA_DIR": str(tmp_path), "COURIER_AUTH_TOKEN": "ck", "COURIER_TO": '{"list_id": "ops"}', "COURIER_CHANNELS": "whatsapp,sms,voice,slack", "SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/x"}
    assert set(notify.channels(env)) == {"courier", "slack"}, "the others are kept"
    r = asyncio.run(notify.send("test", "K1", "both", env, fetch=fetch, force=True))
    assert r["courier"]["ok"] and r["slack"]["ok"]
    assert next(b for u, b in sent if "courier" in u)["message"]["routing"]["channels"] == ["whatsapp", "slack"], "sms and voice are removed from the route"
    # a phone number with no named channels is dropped, so Courier cannot pick SMS on its own
    b = notify._courier_body({}, "t", "b", "", {"email": "a@b.com", "phone_number": "+65123"})
    assert b["message"]["to"] == {"email": "a@b.com"} and "routing" not in b["message"]
    b2 = notify._courier_body({"COURIER_CHANNELS": "whatsapp,email"}, "t", "b", "", {"phone_number": "+65123"})
    assert b2["message"]["to"]["phone_number"] == "+65123" and b2["message"]["routing"]["channels"] == ["whatsapp", "email"]
    assert not any(k in notify.ALL for k in ("sms", "voice", "call"))


def test_self_hosted_apprise_container_is_a_channel_and_sms_or_call_urls_are_refused(tmp_path):
    sent = []

    async def fetch(m, url, h, body):
        sent.append((url, json.loads(body)))
        return 200, "{}"
    base = {"PHOENIX_DATA_DIR": str(tmp_path), "APPRISE_URL": "http://apprise:8000"}
    assert "apprise" not in notify.channels(base), "needs a key or urls"
    r = asyncio.run(notify.send("upgrade-blocked", "A1", "saved key", {**base, "APPRISE_KEY": "phoenix", "APPRISE_TAG": "ops"}, fetch=fetch, force=True))
    assert r["apprise"]["ok"] and sent[0][0] == "http://apprise:8000/notify/phoenix" and sent[0][1]["tag"] == "ops" and sent[0][1]["type"] == "warning"
    sent.clear()
    ok = {**base, "APPRISE_URLS": "whatsapp://TOKEN@PHONEID/+6591234567,slack://a/b/c"}
    assert asyncio.run(notify.send("test", "A2", "urls", ok, fetch=fetch, force=True))["apprise"]["ok"] and sent[0][1]["urls"].startswith("whatsapp://")
    sent.clear()
    bad = asyncio.run(notify.send("test", "A3", "sms", {**base, "APPRISE_URLS": "slack://a/b/c,twilio://sid:tok@+1555/+6591234567"}, fetch=fetch, force=True))
    assert not bad["apprise"]["ok"] and "twilio" in bad["apprise"]["detail"] and not sent, "nothing is sent when one URL would send SMS"
    far = asyncio.run(notify.send("test", "A4", "x", {**base, "APPRISE_URL": "http://evil.example.com", "APPRISE_KEY": "k"}, fetch=fetch, force=True))
    assert not far["apprise"]["ok"] and not sent
    assert notify._apprise_urls_ok(["tgram://x/y", "sms://x"])[0] is False and notify._apprise_urls_ok(["mailto://u:p@host"])[0] is True


def test_enterprise_routes_reach_people_without_any_phone_number(tmp_path):
    sent = []

    async def fetch(m, url, h, body):
        sent.append((url, json.loads(body) if body and body.startswith("{") else body))
        if "login.microsoftonline.com" in url:
            return 200, '{"access_token": "TOK"}'
        if m == "GET":
            return 200, json.dumps({"displayName": "Ann", "mail": "ann@ytl.com", "userPrincipalName": "ann@ytl.com"})
        return 200, "{}"
    env = {"PHOENIX_DATA_DIR": str(tmp_path), "MS_TENANT_ID": "t", "MS_CLIENT_ID": "c", "MS_CLIENT_SECRET": "s", "MS_MAIL_SENDER": "phoenix@ytl.com", "MS_TEAMS_APP_ID": "app-1",
           "TESTOPS_PUSH_URL": "https://push.example.com/p", "WHATSAPP_TOKEN": "w", "WHATSAPP_PHONE_ID": "1", "WHATSAPP_TO": "+6590000000"}
    r = asyncio.run(notify.send("needs-you", "E1", "sign off", env, fetch=fetch, force=True, only=["none"], to=["ann@ytl.com"]))
    assert set(r) == {"email:ann@ytl.com", "teams:ann@ytl.com", "testops-mobile:ann@ytl.com"} and all(v["ok"] for v in r.values())
    assert any("sendActivityNotification" in u for u, _ in sent)
    push = next(b for u, b in sent if "push.example.com" in u)
    assert push["user"] == "ann@ytl.com" and "phone" not in json.dumps(push)
    assert not any("graph.facebook.com" in u for u, _ in sent), "no WhatsApp to a person who gave no number"


def test_defects_and_failures_become_one_whatsapp_digest_and_never_a_flood_of_emails(tmp_path):
    sent = []

    async def fetch(m, url, h, body):
        sent.append((url, json.loads(body) if body.startswith("{") else body))
        return 200, "{}"
    env = {"PHOENIX_DATA_DIR": str(tmp_path), "WHATSAPP_TOKEN": "w", "WHATSAPP_PHONE_ID": "1", "WHATSAPP_TO": "+6590000000", "SMTP_HOST": "smtp.invalid", "SMTP_FROM": "p@ytl.com", "EMAIL_TO": "team@ytl.com"}
    notify._buf.clear()
    for i in range(1200):
        notify.collect("execution-failed", "SHOP", f"case {i}", env, start=False)
    for i in range(40):
        notify.collect("defect-raised", "SHOP", f"SHOP-{i}", env, start=False)
    notify.collect("defect-raised", "BANK", "BANK-1", env, start=False)
    assert not notify.collect("run-result", "SHOP", "x", env, start=False)
    assert sent == [], "counting sends nothing"
    r = asyncio.run(notify.flush_digest(env, fetch=fetch, minutes=15))
    assert set(r) == {"whatsapp"}, "email is left out of high-volume digests unless a route names it"
    assert len(sent) == 1
    text = sent[0][1]["text"]["body"]
    assert "41 defect(s) raised" in text and "1200 execution(s) failed" in text and "SHOP: 1200 execution(s) failed, 40 defect(s) raised" in text and len(text) < 500
    assert asyncio.run(notify.flush_digest(env, fetch=fetch)) == {} and len(sent) == 1, "nothing counted, nothing sent"
    notify.set_routes(env, {"email": {"events": ["digest"]}})
    notify.collect("defect-raised", "SHOP", "SHOP-99", env, start=False)
    assert "email" in asyncio.run(notify.flush_digest(env, fetch=fetch))
