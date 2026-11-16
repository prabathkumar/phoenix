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

## Twilio set-up (WhatsApp, delivery receipts, STOP/START). No SMS and no voice calls are offered.
1. **Try it first (minutes, no approval):** in the Twilio console open Messaging > Try it out > Send a WhatsApp message. Each person sends the join code to Twilio's sandbox number once. Set `WHATSAPP_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM=+14155238886` (the sandbox number) and `WHATSAPP_TO=+65...`. Then `POST /api/notify/test {"channel":"whatsapp"}`.
2. **Production:** register your own WhatsApp sender with Twilio (a number, the business profile, Meta business verification) and create an approved template with one body variable; put its id in `TWILIO_CONTENT_SID`. Without a template, free text only reaches a person who wrote to you in the last 24 hours.
3. **Receipts and replies:** set `PHOENIX_PUBLIC_URL` (the https address Twilio can reach, no trailing slash). In Twilio set the sender's incoming-message webhook to `<PHOENIX_PUBLIC_URL>/api/notify/twilio/inbound`. Phoenix adds the status callback (`/api/notify/twilio/status`) to every message itself. Both calls are checked against `X-Twilio-Signature`; unsigned or forged calls get a 403 and change nothing. With no `PHOENIX_PUBLIC_URL` they are closed.
4. **Replies handled:** STOP / UNSUBSCRIBE / CANCEL / END switches that person's WhatsApp off; START / YES / UNSTOP switches it on. Only a number that a person registered themselves is matched. Anything else is ignored.
Twilio charges its own per-message fee on top of Meta's; check the current price sheet for your countries.

## Use a ready-made notification platform: Courier (`NOTIFY_VIA=courier`)
Instead of wiring each channel, Phoenix makes ONE call to [Courier](https://www.courier.com), which sends to WhatsApp, Slack, Microsoft Teams, email and push. The channels and their providers (for WhatsApp: your Twilio or Meta sender) are set up in Courier's own console.
- Set `COURIER_AUTH_TOKEN`, `COURIER_TO` (JSON: `{"list_id":"phoenix-ops"}`, `{"user_id":"..."}` or `{"email":"...","phone_number":"+65..."}`) and optionally `COURIER_CHANNELS=whatsapp,slack,email` (send on every one listed). Courier sits **beside** the other channels; nothing is dropped. To make it the only sender, also set `NOTIFY_VIA=courier-only`. **No SMS and no calls, ever:** `sms`, `voice` and `call` are removed from `COURIER_CHANNELS`, and a phone number is only passed to Courier when you name its channels (for example `whatsapp`), so Courier cannot choose SMS on its own. Also leave SMS and voice switched off in Courier's console.
- People: the person who started a run gets email, and a phone number only if they opted in to WhatsApp (`PUT /api/notify/me`). Names, mail and mobile still come from the Microsoft directory.
- Texts are masked before they leave, but they do go to Courier, a third-party service: have it checked as a sub-processor. Courier is fully managed and cannot be self-hosted. It bills per send (check the current price sheet; its free tier has been 10,000 sends a month).
- WhatsApp still needs a registered sender and approved templates: Courier does not remove Meta's rules.
- Self-hosted alternative: **Novu** (open core, MIT core, runs in your own containers, covers Slack, Teams, email and push). Its WhatsApp support was not confirmed, so I have not built it in.

## Self-hosted notification platform: Apprise (its own container)
Open source (BSD-2). One container reaches 100+ services, including WhatsApp, Slack, Microsoft Teams (Workflows), email, Telegram, Discord and ntfy. Start it with `docker compose --profile notify up -d apprise`, then set `APPRISE_URL=http://apprise:8000` and EITHER `APPRISE_KEY` (a config saved in the container; optional `APPRISE_TAG`) OR `APPRISE_URLS` (a comma list of Apprise URLs kept in Phoenix's settings, e.g. `whatsapp://TOKEN@PHONE_ID/+6591234567,slack://...`).
- Apprise's WhatsApp service uses Meta's Cloud API, so Meta's registration and templates still apply. Twilio-WhatsApp stays with the direct Twilio channel.
- **No SMS and no calls:** when Phoenix hands Apprise the URLs, any SMS or voice scheme (twilio, sns, vonage, clicksend, ...) is refused and nothing is sent. Configs saved inside the container are outside Phoenix's sight: keep SMS and voice services out of them.
- It is in `tools/tools.json`, so it upgrades through the same VA gate. The image name `caronc/apprise` is from memory: confirm it on the first pull. Nothing was run against a real Apprise container here.
- It sits beside the other channels, Courier included.

## PDPA: no personal phone numbers by default, and WhatsApp as a digest
Not legal advice: have your DPO confirm.
- **Phoenix does not read anyone's mobile number from the directory.** It asks Microsoft Graph for name and work mail only.
- **People are reached by sign-in, not by number:** the Teams app (activity feed, which shows on their phone), the TestOps mobile app (the push carries their sign-in, `user`), and work email. Teams personal push needs the Phoenix Teams app installed for them (`MS_TEAMS_APP_ID`, permission `TeamsActivity.Send`; the manifest declares the activity type `phoenixAlert`); that app package is not built yet.
- **Personal WhatsApp is off.** `NOTIFY_PERSONAL_PHONE=allow` switches it on; even then only a number the person types in themselves (with their consent time kept) is used, it is shown masked, and `DELETE /api/notify/me` erases it and all their choices.
- **WhatsApp for the team goes to company-owned numbers** set by an administrator in `WHATSAPP_TO` (for example an on-call phone issued by YTL), not to numbers collected from users.
- **No flood of emails:** `defect-raised` and `execution-failed` are counted, then sent as ONE short message every `NOTIFY_DIGEST_MINUTES` (default 15), for example "Last 15 min: 41 defect(s) raised, 1201 execution(s) failed", with the top projects and a few examples. Email never gets these unless a route names `digest` for it. `POST /api/notify/digest` sends it now. Urgent things (a run waiting for you, a blocked or rolled-back upgrade) still go out at once.

## The Phoenix Teams app (personal alerts by sign-in)
`teams-app/build.py` makes `phoenix-teams-app.zip`: a Teams app with the activity type `phoenixAlert` and a personal tab that opens Phoenix inside Teams. No secret is in it; its id is your Entra app's Application (client) id.
1. **Entra app registration** (the one behind `MS_CLIENT_ID`): API permissions, Application type: `TeamsActivity.Send`, `User.Read.All`, and `Mail.Send` if email goes through Graph (limit `Mail.Send` to the one sender mailbox with an application access policy). Grant admin consent.
2. **Settings:** `MS_TEAMS_APP_ID` (that same client id) and `PHOENIX_PUBLIC_URL` (the https address people use, no trailing slash) in `.env`.
3. **Build** (needs Pillow, `pip3 install pillow`):
   `cd /Users/prabathkumar/android-sdk/cmdline-tools/phoenix && python3 teams-app/build.py`
4. **Publish:** Teams admin center > Teams apps > Manage apps > Upload new app > `teams-app/phoenix-teams-app.zip`. Then Teams apps > Setup policies > add Phoenix under *Installed apps* so it is installed for your people: an alert can only reach someone who has the app. Changes can take a few hours to reach every user.
5. **Check:** `POST /api/notify/test {"me": true}` as yourself; the alert should appear in the Teams activity feed on your phone and desktop.
The manifest follows Teams schema v1.17 from memory of its fields; Teams rejects a package it dislikes with a reason in the upload dialog, so send me that text if it does.
