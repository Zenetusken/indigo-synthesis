#!/usr/bin/env bash

indigo_host_lock_dir() {
  # Fixed parent keeps the lock host-wide even when worktrees inherit different
  # XDG_RUNTIME_DIR/TMPDIR values. The per-UID leaf is atomically created below.
  local parent="/tmp"
  local directory="$parent/indigo-synthesis-locks-${UID}"
  if mkdir -m 700 "$directory" 2>/dev/null; then
    : # Atomic creation won the race.
  elif [[ ! -d "$directory" || -L "$directory" ]]; then
    echo "ERROR: lock path exists but is not a real directory: $directory" >&2
    return 2
  fi
  if [[ "$(stat -c '%u' "$directory")" != "$UID" ]]; then
    echo "ERROR: lock directory is not owned by the current user: $directory" >&2
    return 2
  fi
  chmod 700 "$directory"
  printf '%s\n' "$directory"
}
