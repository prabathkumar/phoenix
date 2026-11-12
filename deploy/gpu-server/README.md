# Phoenix on the GPU server

Target: the AWS g4dn.xlarge that already runs Qwen3-8B (Tesla T4 16 GB, 4 vCPU, 16 GB RAM, Ubuntu).
Phoenix runs next to the model in Docker. The model stays where it is (llama-server on :8080); Phoenix talks to it through its OpenAI-compatible API.

## Install (on the server, once)

```
sudo PHOENIX_REPO=https://github.com/prabathkumar/phoenix.git bash -c 'curl -fsSL https://raw.githubusercontent.com/prabathkumar/phoenix/main/deploy/gpu-server/install.sh -o /tmp/phoenix-install.sh && bash /tmp/phoenix-install.sh'
```

If the repo is private, clone it to `/opt/phoenix` first (with a token) and run `sudo bash /opt/phoenix/deploy/gpu-server/install.sh`.
The script checks the machine, installs Docker if missing, writes `.env` with new random passwords (kept only on the server), builds and starts Phoenix, enables start on boot, and runs `scripts/validate_platform.py`. It can be run again to update.

## Reaching it

Phoenix listens on `127.0.0.1:8000` only. Nothing new is open to the internet.

**Option A, tunnel (recommended):** `ssh -L 8000:127.0.0.1:8000 <user>@<server>` then open http://localhost:8000. With AWS SSM instead of SSH: `aws ssm start-session --target <instance-id> --document-name AWS-StartPortForwardingSession --parameters '{"portNumber":["8000"],"localPortNumber":["8000"]}'`.

**Option B, HTTPS and a shared password:** make a password hash on the server, put it in `.env`, start the proxy, and open port 443 in the security group only to your office/VPN range.
```
cd /opt/phoenix
docker run --rm caddy:2 caddy hash-password --plaintext 'CHOOSE-A-LONG-PASSWORD'
# put the output in .env as PHOENIX_PROXY_HASH='...' (single quotes), and PHOENIX_PROXY_USER=phoenix
docker compose -f docker-compose.yml -f deploy/gpu-server/docker-compose.gpu.yml --profile platform --profile proxy up -d
```
**Important:** Phoenix has no login of its own yet. Whoever gets through the proxy can claim any name, so the four-eyes sign-off and "my avatar" are only as trustworthy as that shared password. Use Option A, or add real login before relying on sign-off as an audit trail.

## Limits to know about (16 GB box)

- Memory budget is in `docker-compose.gpu.yml`: about 13 GB used with the model loaded. **One browser run at a time.** Several testers running browsers at once will not fit; the model server also handles 2 requests at a time (`--parallel 2`).
- The 8B model is slow: scenarios and cases take about a minute or more each. The model timeout is raised to 5 minutes.
- The instance is started and stopped by the Lambda. Phoenix starts on boot (`phoenix.service`), and its data is on Docker volumes on the instance disk, so it survives a stop. **If the instance is ever terminated (not stopped), the volumes go with it.** Take EBS snapshots.
- Back up the database: `docker compose exec postgres pg_dump -U phoenix phoenix > /opt/phoenix-backup-$(date +%F).sql`.

## Securing the model endpoint (do this; it is open today)

llama-server on `0.0.0.0:8080` has no key. Add `--api-key <long-random>` to its service file, set the same key in Phoenix (`LLM_API_KEY=` in `/opt/phoenix/.env`) and in TestOps, restart both, and restrict port 8080 in the security group to the TestOps/Lambda sources. Phoenix reaches the model over the Docker host address, so it needs no inbound rule of its own.
Do not change one side without the other: TestOps calls this endpoint too.

## Check it

```
curl -s http://127.0.0.1:8000/api/health
python3 /opt/phoenix/scripts/validate_platform.py http://127.0.0.1:8000
docker compose -f /opt/phoenix/docker-compose.yml -f /opt/phoenix/deploy/gpu-server/docker-compose.gpu.yml ps
free -h; nvidia-smi --query-gpu=memory.used,memory.total --format=csv
```

## Not verified

Written against the setup in the infra chat, not run on that server: the Docker build on Ubuntu x86 (it was built on an Apple-silicon Mac), the memory limits under real load, the Caddy proxy, the boot unit, and Qwen3-8B's JSON quality on Phoenix's prompts (its answers go through the same checks as any model, but small models drift).
