#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
name="${1:-vps-worker}"
shift || true

docker compose run --rm --name "ci-vimeo-${name}" worker npm run migrate "$@"
