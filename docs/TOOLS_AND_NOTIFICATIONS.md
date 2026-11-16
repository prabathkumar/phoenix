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

## The phone
- **TestOps mobile app**: set `TESTOPS_PUSH_URL` (+ `TESTOPS_PUSH_TOKEN`). Phoenix POSTs `{event, title, body, project, link}`; the app side of that contract has to exist (it is not in this repo).
- **WhatsApp** (Meta Cloud API): `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_TO` (comma list). Free text only works inside WhatsApp's 24-hour window after the person last wrote; set `WHATSAPP_TEMPLATE` (approved, one body variable) to reach them any time.
- Sent for: upgrade blocked / promoted / rolled back, and every run that finishes or waits for you. `POST /api/notify/test` checks the setup. Texts are masked and cut short first; a phone that is off never fails a run.
