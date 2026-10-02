#!/usr/bin/env bash
# Builds the Phoenix image under the "testops-mobile" name/tag and exports
# it to a single .tar.gz file, so it can be handed to a team that has no
# shared container registry set up yet -- just a file to download and
# `docker load`.
#
# This script does not push anywhere. There is no registry wired into this
# repo or this sandbox; if/when TestOps stands up their own registry
# (ECR, GCR, Harbor, Docker Hub, whatever they already use), swap the
# `docker save` step below for a `docker tag` + `docker push` to it -- the
# build step is unaffected either way.
#
# Usage:
#   ./scripts/build-testops-mobile.sh [version]
#
#   version   Optional tag suffix, e.g. "1.0.0". Defaults to the short git
#             commit hash of HEAD, so every export is traceable back to the
#             exact source it was built from.

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-$(git rev-parse --short HEAD 2>/dev/null || echo "latest")}"
IMAGE="testops-mobile:${VERSION}"
OUT_DIR="dist"
OUT_FILE="${OUT_DIR}/testops-mobile-${VERSION}.tar.gz"

echo "Building ${IMAGE} ..."
docker build -t "${IMAGE}" -t "testops-mobile:latest" .

mkdir -p "${OUT_DIR}"
echo "Exporting to ${OUT_FILE} ..."
docker save "${IMAGE}" | gzip > "${OUT_FILE}"

echo ""
echo "Done. ${OUT_FILE} ($(du -h "${OUT_FILE}" | cut -f1)) is ready to hand off."
echo ""
echo "On the receiving machine:"
echo "  gunzip -c testops-mobile-${VERSION}.tar.gz | docker load"
echo "  docker run --env-file .env -p 8090:8090 -p 8091:8091 ${IMAGE}"
