#!/usr/bin/env bash
# Serialize destructive reset + Playwright for one E2E resource identity.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
source scripts/lib/host-lock.sh

MODE="${1:-}"
if [[ "$MODE" != "default" && "$MODE" != "llm" ]]; then
  echo "Usage: scripts/e2e/run.sh <default|llm>" >&2
  exit 2
fi
if ! command -v flock >/dev/null 2>&1; then
  echo "ERROR: flock is required to protect the destructive E2E reset" >&2
  exit 2
fi

NODE_ENV_FILES=(--env-file-if-exists=.env.local --env-file-if-exists=.env.e2e.local)
# One conservative host lock covers every shared hazard: destructive database reset,
# application/control ports, and checkout-local Next artifacts.
LOCK_PATH="$(indigo_host_lock_dir)/e2e.lock"
exec 9>"$LOCK_PATH"
if ! flock -n 9; then
  echo "ERROR: another Indigo E2E reset/browser run is active ($LOCK_PATH)" >&2
  exit 75
fi

NODE_ENV=test node "${NODE_ENV_FILES[@]}" --import tsx scripts/db/reset-e2e.ts

PLAYWRIGHT=(
  node
  "${NODE_ENV_FILES[@]}"
  ./node_modules/@playwright/test/cli.js
  test
)
if [[ "$MODE" == "llm" ]]; then
  PLAYWRIGHT+=(-c playwright.llm.config.ts)
fi
"${PLAYWRIGHT[@]}"
