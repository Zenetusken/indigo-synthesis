#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source scripts/lib/host-lock.sh

if [[ $# -lt 1 ]]; then
  echo "Usage: scripts/run-external-host-command.sh TYPESCRIPT_ENTRYPOINT [ARGUMENT ...]" >&2
  exit 2
fi
if ! command -v flock >/dev/null 2>&1; then
  echo "ERROR: flock is required to serialize Indigo host database commands" >&2
  exit 2
fi

ENTRYPOINT="$1"
shift
LOCK_PATH="$(indigo_host_lock_dir)/database-external-host.lock"
exec 9>"$LOCK_PATH"
if ! flock -n 9; then
  echo "ERROR: another Indigo host database command is active ($LOCK_PATH)" >&2
  exit 75
fi

export INDIGO_EXTERNAL_HOST_LOCK_HELD=1
export INDIGO_EXTERNAL_HOST_LOCK_FD=9
export INDIGO_EXTERNAL_HOST_LOCK_PATH="$LOCK_PATH"

exec node --env-file-if-exists=.env.local --import tsx "$ENTRYPOINT" "$@"
