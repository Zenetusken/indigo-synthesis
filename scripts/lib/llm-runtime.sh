#!/usr/bin/env bash

indigo_assert_llm_model_load_memory() {
  local root="$1"
  local meminfo_path="${2:-/proc/meminfo}"
  local artifact_lock="$root/llm/models/qwen3.5-9b-q4_k_m/artifact.lock.json"
  local artifact_bytes
  local mem_available_kib
  local mem_available_bytes
  local headroom_bytes=$((4 * 1024 * 1024 * 1024))
  local required_bytes

  artifact_bytes="$(
    node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).sizeBytes" \
      "$artifact_lock"
  )"
  if ! [[ "$artifact_bytes" =~ ^[0-9]+$ ]] || (( artifact_bytes <= 0 )); then
    echo "FATAL: artifact lock has an invalid sizeBytes value: $artifact_bytes" >&2
    return 2
  fi

  mem_available_kib="$(awk '$1 == "MemAvailable:" { print $2; found=1; exit } END { if (!found) exit 1 }' "$meminfo_path")" || {
    echo "FATAL: $meminfo_path does not report MemAvailable" >&2
    return 2
  }
  if ! [[ "$mem_available_kib" =~ ^[0-9]+$ ]]; then
    echo "FATAL: $meminfo_path reported an invalid MemAvailable value" >&2
    return 2
  fi

  mem_available_bytes=$((mem_available_kib * 1024))
  required_bytes=$((artifact_bytes + headroom_bytes))
  if (( mem_available_bytes < required_bytes )); then
    echo "FATAL: model start requires artifact bytes + 4 GiB RAM headroom" >&2
    echo "  MemAvailable=$mem_available_bytes required=$required_bytes artifact=$artifact_bytes" >&2
    return 2
  fi

  echo "Model-load RAM OK: MemAvailable=$mem_available_bytes required=$required_bytes"
}

indigo_validate_inherited_llm_lifecycle_lock() {
  local lifecycle_lock="$1"
  local lock_fd="$2"
  local inherited_lock_path
  local lock_probe_fd

  if ! [[ "$lock_fd" =~ ^[0-9]+$ ]] || (( lock_fd < 3 )); then
    echo "FATAL: inherited LLM lifecycle lock fd is invalid" >&2
    return 2
  fi
  inherited_lock_path="$(readlink "/proc/$$/fd/$lock_fd" 2>/dev/null || true)"
  if [[ "$inherited_lock_path" != "$lifecycle_lock" ]]; then
    echo "FATAL: inherited fd $lock_fd is not the LLM lifecycle lock" >&2
    return 2
  fi

  exec {lock_probe_fd}>"$lifecycle_lock"
  if flock -n "$lock_probe_fd"; then
    flock -u "$lock_probe_fd"
    exec {lock_probe_fd}>&-
    echo "FATAL: inherited LLM lifecycle fd is not locked" >&2
    return 2
  fi
  exec {lock_probe_fd}>&-
  if ! flock -n "$lock_fd"; then
    echo "FATAL: inherited LLM lifecycle fd does not own the active lock" >&2
    return 2
  fi
}

indigo_hold_llm_lifecycle_lock_until_exit() {
  local pid="$1"
  local lock_fd="$2"

  # A live but unverified launcher is the exact state in which another start must
  # remain blocked. Keep this watcher-owned duplicate until that process exits.
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
  done
  flock -u "$lock_fd"
}
