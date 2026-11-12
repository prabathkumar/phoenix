#!/usr/bin/env bash
# Installs Phoenix on the GPU server. Run as root on the instance:   sudo bash install.sh
# Safe to run again: it keeps an existing .env (and so the database passwords) and only pulls and rebuilds.
set -euo pipefail

DIR=/opt/phoenix
REPO=${PHOENIX_REPO:-https://github.com/prabathkumar/phoenix.git}
say() { printf '\n== %s\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }

say "Checking the machine"
. /etc/os-release; echo "OS: $PRETTY_NAME"
mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo); echo "RAM: $((mem_kb / 1024 / 1024)) GB"
[ "$mem_kb" -ge 14000000 ] || echo "WARNING: under 14 GB of RAM. The limits in docker-compose.gpu.yml assume 16 GB."
nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader 2>/dev/null || echo "WARNING: no GPU found (nvidia-smi)."
if systemctl is-active --quiet llama-server; then
  echo "llama-server: running"
  curl -fsS --max-time 5 http://localhost:8080/health >/dev/null && echo "llama-server health: ok" || echo "WARNING: llama-server did not answer /health on :8080"
else
  echo "WARNING: llama-server is not running. Phoenix will start, but the AI steps will say 'no model reachable' until it is."
fi
df -h / | tail -1 | awk '{print "Disk free on /: " $4}'

say "Docker"
if ! command -v docker >/dev/null; then
  apt-get update -y && apt-get install -y ca-certificates curl git
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null || { echo "docker compose plugin missing"; exit 1; }
command -v git >/dev/null || apt-get install -y git

say "Code"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else
  echo "Cloning $REPO  (a private repo needs: PHOENIX_REPO=https://<user>:<token>@github.com/prabathkumar/phoenix.git)"
  git clone "$REPO" "$DIR"
fi
cd "$DIR"

say "Settings (.env)"
rand() { head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 28; }
if [ ! -f .env ]; then
  cp .env.example .env
  {
    echo ""; echo "# --- added by deploy/gpu-server/install.sh"
    echo "POSTGRES_PASSWORD=$(rand)"; echo "CLICKHOUSE_PASSWORD=$(rand)"; echo "ZAP_API_KEY=$(rand)"
    echo "PHOENIX_BIND=127.0.0.1"; echo "LLM_BASE_URL=http://host.docker.internal:8080/v1"; echo "LLM_MODEL=qwen3-8b"; echo "LLM_API_KEY="
  } >> .env
  chmod 600 .env
  echo "Created .env with new random passwords (kept on this server only)."
else
  echo ".env exists: left as it is."
fi
grep -q '^TESTOPS_MOBILE_OLLAMA_HOST=' .env && echo "NOTE: .env still has an Ollama host set; LLM_BASE_URL takes priority, so it is ignored."

say "Build and start (the first build takes several minutes)"
docker compose -f docker-compose.yml -f deploy/gpu-server/docker-compose.gpu.yml --profile platform up -d --build postgres clickhouse zap engine phoenix-api

say "Start on boot (the instance is started and stopped by the Lambda)"
install -m 644 deploy/gpu-server/phoenix.service /etc/systemd/system/phoenix.service
systemctl daemon-reload && systemctl enable phoenix.service >/dev/null

say "Waiting for the API"
for i in $(seq 1 60); do curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1 && break; sleep 3; done
curl -fsS http://127.0.0.1:8000/api/health >/dev/null && echo "Phoenix API is up on 127.0.0.1:8000" || { echo "API did not come up. Look: docker compose logs --tail 80 phoenix-api"; exit 1; }
python3 scripts/validate_platform.py http://127.0.0.1:8000 || true

cat <<MSG

Done. Phoenix listens on 127.0.0.1:8000 only, so nothing new is open to the internet.
  Reach it from your laptop:   ssh -L 8000:127.0.0.1:8000 <user>@<this server>     then open http://localhost:8000
  Or with HTTPS + password:    see deploy/gpu-server/README.md ("Option B")
MSG
