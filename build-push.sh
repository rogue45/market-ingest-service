#!/usr/bin/env bash
# Builds the market-ingest-service image for the deployment platform (linux/amd64), tags it with
# both `latest` and a version tag (YYYYMMDD-<git short sha>, with -dirty appended if the working
# tree has uncommitted changes), and pushes both tags to the LAN registry.
#
# The explicit --platform matters: this is normally built on an arm64 Mac, and an image built
# without it will push arm64 and fail on the amd64 host with "exec format error".
#
# Usage: ./build-push.sh
#   REGISTRY=my.registry:5000 ./build-push.sh   # override registry
set -euo pipefail
cd "$(dirname "$0")"

REGISTRY="${REGISTRY:-192.168.1.53:5000}"
SHORT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo nogit)
DIRTY=""
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
   DIRTY="-dirty"
fi
VERSION="$(date +%Y%m%d)-${SHORT_SHA}${DIRTY}"

echo "Building market-ingest-service:${VERSION} (and latest) for linux/amd64..."
docker build --platform linux/amd64 -t market-ingest-service:latest -t "market-ingest-service:${VERSION}" .

docker tag market-ingest-service:latest "${REGISTRY}/market-ingest-service:latest"
docker tag "market-ingest-service:${VERSION}" "${REGISTRY}/market-ingest-service:${VERSION}"

echo "Pushing ${REGISTRY}/market-ingest-service:${VERSION} and :latest..."
docker push "${REGISTRY}/market-ingest-service:${VERSION}"
docker push "${REGISTRY}/market-ingest-service:latest"

echo ""
echo "Pushed. Pin this version in docker-compose with:"
echo "  image: ${REGISTRY}/market-ingest-service:${VERSION}"
