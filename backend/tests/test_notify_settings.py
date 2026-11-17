import json
import pytest
from fastapi.testclient import TestClient
from phoenix_api import notify, notify_settings as ns
from phoenix_api.app import create_app
from phoenix_api.service import Deps


def env(tmp_path, **kw):
    return {"PHOENIX_DATA_DIR": str(tmp_path), "PHOENIX_ADMINS": "boss@ytl.com", "PHOENIX_SETTINGS_KEY": "k" * 20, **kw}


def test_only_admins_change_settings_and_none_named_means_nobody(tmp_path):
    e = env(tmp_path)
    with pytest.raises(PermissionError):
        ns.save(e, "ann@ytl.com", {"SLACK_CHANNEL": "#x"})
    e2 = env(tmp_path); e2["PHOENIX_ADMINS"] = ""
    with pytest.raises(PermissionError):
        ns.save(e2, "boss@ytl.com", {"SLACK_CHANNEL": "#x"})


def test_secrets_are_encrypted_on_disk_never_shown_and_override_the_environment(tmp_path):
    e = env(tmp_path, SLACK_WEBHOOK_URL="https://hooks.slack.com/services/OLD")
    ns.save(e, "boss@ytl.com", {"SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/T1/B2/SECRETPART"})
    raw = open(tmp_path / "notify-settings.json").read()
    assert "SECRETPART" not in raw
    shown = json.dumps(ns.view(e))
    assert "SECRETPART" not in shown and "OLD" not in shown
    assert notify.resolve(e)["SLACK_WEBHOOK_URL"].endswith("SECRETPART")
    assert "slack" in notify.channels(notify.resolve(e))
    ns.save(e, "boss@ytl.com", {"SLACK_WEBHOOK_URL": ""})            # blank keeps
    assert notify.resolve(e)["SLACK_WEBHOOK_URL"].endswith("SECRETPART")
    ns.save(e, "boss@ytl.com", {"SLACK_WEBHOOK_URL": "clear"})
    assert notify.resolve(e)["SLACK_WEBHOOK_URL"].endswith("OLD")     # back to the environment value


def test_no_key_means_no_secret_is_stored_and_a_wrong_key_reads_nothing(tmp_path):
    e = env(tmp_path); e.pop("PHOENIX_SETTINGS_KEY")
    with pytest.raises(ValueError, match="PHOENIX_SETTINGS_KEY"):
        ns.save(e, "boss@ytl.com", {"SLACK_BOT_TOKEN": "xoxb-1"})
    ns.save(e, "boss@ytl.com", {"SLACK_CHANNEL": "#ops"})            # plain values need no key
    good = env(tmp_path)
    ns.save(good, "boss@ytl.com", {"SLACK_BOT_TOKEN": "xoxb-2"})
    wrong = env(tmp_path); wrong["PHOENIX_SETTINGS_KEY"] = "z" * 20
    assert "SLACK_BOT_TOKEN" not in ns.load(wrong)


@pytest.mark.parametrize("k,v", [
    ("SLACK_WEBHOOK_URL", "https://evil.example.com/x"), ("TEAMS_WEBHOOK_URL", "http://x.webhook.office.com/a"),
    ("NOTIFY_DIGEST_MINUTES", "0"), ("NOTIFY_DIGEST_MINUTES", "abc"), ("PHOENIX_NOTIFY_MIN", "loud"),
    ("COURIER_CHANNELS", "whatsapp,sms"), ("COURIER_TO", "[1]"), ("WHATSAPP_TO", "call me"),
    ("APPRISE_URLS", "twilio://a:b@c/+1"), ("APPRISE_URL", "http://example.com:8000"), ("UNKNOWN_KEY", "x")])
def test_bad_values_are_refused(tmp_path, k, v):
    with pytest.raises(ValueError):
        ns.save(env(tmp_path), "boss@ytl.com", {k: v})


def test_api_endpoints(tmp_path):
    e = env(tmp_path)
    c = TestClient(create_app(Deps(env=e)))
    r = c.get("/api/notify/settings", headers={"X-User": "ann@ytl.com"}).json()
    assert r["canEdit"] is False and r["canStoreSecrets"] is True and "digest" in r["events"]
    assert c.put("/api/notify/settings", json={"values": {"SLACK_CHANNEL": "#a"}}, headers={"X-User": "ann@ytl.com"}).status_code == 403
    assert c.put("/api/notify/settings", json={"values": {"SLACK_CHANNEL": "#a"}}).status_code == 401
    assert c.put("/api/notify/settings", json={"values": {"NOTIFY_DIGEST_MINUTES": "x"}}, headers={"X-User": "boss@ytl.com"}).status_code == 400
    ok = c.put("/api/notify/settings", json={"values": {"SLACK_CHANNEL": "#a", "TELEGRAM_BOT_TOKEN": "123:ABC"}}, headers={"X-User": "boss@ytl.com"})
    assert ok.status_code == 200 and ok.json()["changed"] == ["SLACK_CHANNEL", "TELEGRAM_BOT_TOKEN"]
    v = c.get("/api/notify/settings", headers={"X-User": "boss@ytl.com"})
    assert v.json()["canEdit"] is True and "123:ABC" not in v.text
