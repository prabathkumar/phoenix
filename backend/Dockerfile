# Phoenix API + UI: React is built in the first stage, FastAPI serves it and the API on :8000.
# Not build-verified from the sandbox (no Docker daemon): run `docker compose --profile platform up --build` once and then scripts/validate_platform.py.
FROM node:22-slim AS ui
WORKDIR /ui
COPY web-ui/package.json web-ui/package-lock.json ./
RUN npm ci
COPY web-ui/ ./
RUN npm run build

FROM python:3.13-slim
ARG WITH_SECURITY_TOOLS=true
ARG WITH_DEEPEVAL=true
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PHOENIX_UI_DIR=/app/ui
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates poppler-utils git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install -r /app/backend/requirements.txt "sqlalchemy>=2.0" "psycopg[binary]>=3.2" "clickhouse-connect>=0.8"
# Locust (load), Semgrep (SAST), Gitleaks (secrets), DeepEval (AI answer quality)
RUN if [ "$WITH_SECURITY_TOOLS" = "true" ]; then pip install locust semgrep \
 && curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_linux_x64.tar.gz | tar -xz -C /usr/local/bin gitleaks; fi
RUN if [ "$WITH_DEEPEVAL" = "true" ]; then pip install deepeval; fi
COPY backend/ /app/backend/
COPY prompts/ /app/prompts/
COPY scripts/deepeval_run.py /app/scripts/deepeval_run.py
COPY --from=ui /ui/dist /app/ui
WORKDIR /app/backend
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://localhost:8000/api/health || exit 1
CMD ["uvicorn", "phoenix_api.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
