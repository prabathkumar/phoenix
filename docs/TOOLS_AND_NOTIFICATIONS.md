# Open source tools as containers, the VA gate, and the phone

## Separate containers
Every open source tool (Semgrep, Gitleaks, Trivy, Locust, ZAP) has its own pinned image in `tools/tools.json`. Nothing is installed into the platform image, so upgrading a tool never touches Phoenix.
- `docker compose --profile tools pull` fetches the pinned images. ZAP already runs as its own service.
- `PHOENIX_TOOL_MODE=container` makes the secrets and SAST stages run Gitleaks and Semgrep as throw-away containers (no network, read-only mount, all capabilities dropped, never privileged).
- **Needs Docker on the machine that runs the API.** The API container is NOT given the Docker socket (that would be root on the host). Run the API on a host with Docker, or leave the mode at `local`.

## The upgrade gate (the VA)
`POST /api/tools/<id>/upgrade` (a named person, `X-User`) does this, and never touches the live version until the end:
1. finds the newest release on GitHub; same as live: stop ("current");
2. pulls the new image aside;
3. scans it: **Trivy** on the image; **Semgrep** and **Gitleaks** on the tool's own source at that release tag;
4. blocks if a scan could not run, a CRITICAL vulnerability is in the image, any secret is in the source, or HIGH vulnerabilities / SAST errors grew past the live version's baseline;
5. otherwise promotes (writes `tools.lock.json`), then runs the new container's health check; if it does not start, **the previous version is put back** (self-healing).
Every outcome goes to the phone. `GET /api/tools` shows live version, previous version, last check and baseline. Nothing runs this on a schedule yet: create a scheduled task that POSTs the upgrade for each tool.

## Notifications platform
One sender (`notify.py`) for every channel; set up by environment values, shown by `GET /api/notify/channels`.

| Channel | Set | Notes |
|---|---|---|
| Slack | `SLACK_WEBHOOK_URL` (hooks.slack.com) or `SLACK_BOT_TOKEN` + `SLACK_CHANNEL` | |
| Microsoft Teams | `TEAMS_WEBHOOK_URL` (a Workflows / Power Automate webhook) | posts an Adaptive Card to a channel |
| WhatsApp | Meta: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_TO`. **Twilio (easier):** `WHATSAPP_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `WHATSAPP_TO` | see below |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | |
| Discord / Google Chat | `DISCORD_WEBHOOK_URL` / `GOOGLE_CHAT_WEBHOOK_URL` | |
| Email | `SMTP_HOST`, `SMTP_FROM`, `EMAIL_TO` (+ `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`) | |
| ntfy | `NTFY_URL` (+ `NTFY_TOKEN`) | push to a phone with no account |
| Webhook | `NOTIFY_WEBHOOK_URL` (+ `NOTIFY_WEBHOOK_SECRET`: HMAC-SHA256 in `X-Phoenix-Signature`) | for anything else |
| TestOps mobile app | `TESTOPS_PUSH_URL` (+ `TESTOPS_PUSH_TOKEN`) | the app's side of the push contract must exist |

- **Safety:** named platforms accept only their own hosts over https, so a wrong or hijacked setting cannot send messages elsewhere. Texts are masked and cut to size; the same message is not repeated within a minute; a 5xx is retried once.
- **Routing:** `PUT /api/notify/routes` sets, per channel, which events (`run-result`, `needs-you`, `upgrade-blocked`, `upgrade-promoted`, `upgrade-rolled-back`, ...) and the lowest level (`info` < `warn` < `error`). `GET /api/notify/log` shows what was delivered or failed.
- **People (Microsoft sign-in):** with `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` (an app with read-only `User.Read.All`) Phoenix reads a person's mail and mobile from the directory. The person who started a run gets it personally: email (Graph `sendMail` with `MS_MAIL_SENDER` and `Mail.Send`, else SMTP) and WhatsApp **only if they opted in** (`PUT /api/notify/me {"whatsapp": true}`; they may give another number). Each person sets only their own choices. A Teams personal push (activity feed) needs a registered Teams app and is not built.
- **WhatsApp alternatives to Meta direct:** Twilio, 360dialog, Vonage, Infobip, Bird and Gupshup are all official providers on the same WhatsApp Business Platform. They make sign-up and the API simpler, but the rules stay Meta's: a registered business number, approved templates, and free text only inside the 24-hour window. Twilio is built in here (its sandbox lets you test in minutes). Tools that link a normal number by QR code are easier still, but break WhatsApp's terms and can get the number banned, so they are not offered.

## Twilio set-up (WhatsApp, delivery receipts, STOP/START, SMS)
1. **Try it first (minutes, no approval):** in the Twilio console open Messaging > Try it out > Send a WhatsApp message. Each person sends the join code to Twilio's sandbox number once. Set `WHATSAPP_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM=+14155238886` (the sandbox number) and `WHATSAPP_TO=+65...`. Then `POST /api/notify/test {"channel":"whatsapp"}`.
2. **Production:** register your own WhatsApp sender with Twilio (a number, the business profile, Meta business verification) and create an approved template with one body variable; put its id in `TWILIO_CONTENT_SID`. Without a template, free text only reaches a person who wrote to you in the last 24 hours.
3. **Receipts and replies:** set `PHOENIX_PUBLIC_URL` (the https address Twilio can reach, no trailing slash). In Twilio set the sender's incoming-message webhook to `<PHOENIX_PUBLIC_URL>/api/notify/twilio/inbound`. Phoenix adds the status callback (`/api/notify/twilio/status`) to every message itself. Both calls are checked against `X-Twilio-Signature`; unsigned or forged calls get a 403 and change nothing. With no `PHOENIX_PUBLIC_URL` they are closed.
4. **Replies handled:** STOP / UNSUBSCRIBE / CANCEL / END switches that person's WhatsApp off; START / YES / UNSTOP switches it on. Only a number that a person registered themselves is matched. Anything else is ignored.
5. **SMS fallback:** `SMS_TO`, `TWILIO_SMS_FROM` (same account) adds an `sms` channel. Delivery to Singapore and Malaysia numbers may need sender-ID registration; check Twilio's country guidelines.
Twilio charges its own per-message fee on top of Meta's; check the current price sheet for your countries.
