#!/usr/bin/env bash
# Start GPU-only loopback llama-server for Indigo's LLM layer.
# Refuses to start if NVIDIA is unhealthy (product policy: no CPU inference).
set -euo pipefail

PORT="${INDIGO_LLM_PORT:-8080}"
HOST="${INDIGO_LLM_HOST:-127.0.0.1}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/scripts/lib/host-lock.sh"
source "$ROOT/scripts/lib/llm-runtime.sh"
if (( $# > 0 )); then
  if (( $# != 2 )) || [[ "$1" != "--check-inherited-lifecycle-lock" ]]; then
    echo "FATAL: unsupported serve-local argument" >&2
    exit 2
  fi
  if ! command -v flock >/dev/null 2>&1; then
    echo "FATAL: flock is required to validate an inherited lifecycle lock" >&2
    exit 2
  fi
  if [[ "${INDIGO_LLM_LIFECYCLE_LOCK_FD:-}" != "9" ]]; then
    echo "FATAL: inherited LLM lifecycle lock must use fd 9" >&2
    exit 2
  fi
  indigo_validate_inherited_llm_lifecycle_lock "$2" 9
  echo "Inherited LLM lifecycle lock is valid"
  exit 0
fi
if [[ -n "${INDIGO_LLM_WEIGHTS:-}" ]]; then
  echo "FATAL: INDIGO_LLM_WEIGHTS is unsupported; use the committed llm/weights artifact path" >&2
  exit 2
fi
WEIGHTS="$ROOT/llm/weights/qwen3.5-9b-q4_k_m.gguf"
ALIAS="${INDIGO_LLM_SERVED_NAME:-qwen3.5-9b-q4_k_m}"
CTX=4096
# Product default: llama.cpp's literal `all` offloads every model layer.
NGL="${INDIGO_LLM_N_GPU_LAYERS:-all}"
REQUIRE_GPU="${INDIGO_LLM_REQUIRE_GPU:-true}"
ATTESTATION_PATH="${INDIGO_LLM_ATTESTATION_PATH:-$ROOT/tmp/llm-runtime-attestation.json}"
MODEL_ID="${INDIGO_LLM_MODEL_ID:-qwen3.5-9b-q4_k_m}"
EXPECTED_ALIAS="qwen3.5-9b-q4_k_m"

if [[ "$HOST" != "127.0.0.1" ]]; then
  echo "FATAL: supported LLM launcher binds exactly to 127.0.0.1; got $HOST" >&2
  exit 2
fi
if [[ "$PORT" != "8080" ]]; then
  echo "FATAL: supported LLM launcher binds exactly to port 8080; got $PORT" >&2
  exit 2
fi
if [[ -n "${INDIGO_LLM_CTX:-}" && "$INDIGO_LLM_CTX" != "$CTX" ]]; then
  echo "FATAL: supported LLM launcher requires INDIGO_LLM_CTX=$CTX" >&2
  exit 2
fi
if [[ "$MODEL_ID" != "$EXPECTED_ALIAS" || "$ALIAS" != "$EXPECTED_ALIAS" ]]; then
  echo "FATAL: supported LLM launcher only serves the committed $EXPECTED_ALIAS pack" >&2
  exit 2
fi
if [[ "$NGL" != "all" ]]; then
  echo "FATAL: supported LLM launcher requires INDIGO_LLM_N_GPU_LAYERS=all" >&2
  exit 2
fi
if [[ "$REQUIRE_GPU" == "false" || "$REQUIRE_GPU" == "0" ]]; then
  echo "FATAL: supported local inference requires CUDA; use an ad-hoc command for diagnosis" >&2
  exit 2
fi

if ! command -v flock >/dev/null 2>&1; then
  echo "FATAL: flock is required to serialize LLM runtime transitions" >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "FATAL: curl is required to verify the LLM runtime handoff" >&2
  exit 2
fi
LOCK_DIR="$(indigo_host_lock_dir)"
LIFECYCLE_LOCK="$LOCK_DIR/llm-runtime-lifecycle.lock"
LIFECYCLE_LOCK_FD=9
OWNS_LIFECYCLE_LOCK=false
if [[ -n "${INDIGO_LLM_LIFECYCLE_LOCK_FD:-}" ]]; then
  if [[ "$INDIGO_LLM_LIFECYCLE_LOCK_FD" != "$LIFECYCLE_LOCK_FD" ]]; then
    echo "FATAL: inherited LLM lifecycle lock must use fd $LIFECYCLE_LOCK_FD" >&2
    exit 2
  fi
  indigo_validate_inherited_llm_lifecycle_lock \
    "$LIFECYCLE_LOCK" \
    "$LIFECYCLE_LOCK_FD"
else
  exec 9>"$LIFECYCLE_LOCK"
  if ! flock -n "$LIFECYCLE_LOCK_FD"; then
    echo "FATAL: another LLM runtime transition is active ($LIFECYCLE_LOCK)" >&2
    exit 75
  fi
  export INDIGO_LLM_LIFECYCLE_LOCK_FD="$LIFECYCLE_LOCK_FD"
  OWNS_LIFECYCLE_LOCK=true
fi
if ! command -v lsof >/dev/null 2>&1; then
  echo "FATAL: lsof is required to prevent duplicate local model starts" >&2
  exit 2
fi
if [[ -n "$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)" ]]; then
  echo "FATAL: $HOST:$PORT already has a listener; use pnpm llm:measure-gpu for an attested replacement" >&2
  exit 2
fi

resolve_llama_server() {
  if [[ -n "${INDIGO_LLAMA_SERVER:-}" && -x "${INDIGO_LLAMA_SERVER}" ]]; then
    echo "$INDIGO_LLAMA_SERVER"
    return
  fi
  if command -v llama-server >/dev/null 2>&1; then
    command -v llama-server
    return
  fi
  local candidate="$HOME/project/llama.cpp-indigo/build/bin/llama-server"
  if [[ -x "$candidate" ]]; then
    echo "$candidate"
    return
  fi
  return 1
}

assert_gpu_ready() {
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "FATAL: nvidia-smi missing. GPU-only LLM layer cannot start." >&2
    exit 2
  fi
  if ! nvidia-smi >/dev/null 2>&1; then
    echo "FATAL: nvidia-smi unhealthy (often driver/library mismatch)." >&2
    echo "Reboot so the loaded NVIDIA module matches installed nvidia-utils/DKMS." >&2
    nvidia-smi 2>&1 | head -5 >&2 || true
    echo "Loaded module: $(cat /sys/module/nvidia/version 2>/dev/null || echo unknown)" >&2
    exit 2
  fi
  echo "GPU OK:"
  nvidia-smi --query-gpu=name,driver_version,memory.total,memory.free --format=csv,noheader
}

if ! LLAMA_BIN="$(resolve_llama_server)"; then
  echo "FATAL: llama-server not found. Build with: pnpm llm:build-cuda" >&2
  exit 1
fi

if [[ ! -f "$WEIGHTS" ]]; then
  echo "FATAL: weights missing at $WEIGHTS — run pnpm llm:download-qwen35" >&2
  exit 1
fi

assert_gpu_ready

# The supported runtime does not inherit user-controlled dynamic-loader overrides.
unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT DYLD_INSERT_LIBRARIES

node --import tsx scripts/llm/write-runtime-attestation.ts \
  --root "$ROOT" \
  --pid "$$" \
  --endpoint "http://$HOST:$PORT/v1" \
  --model-id "$MODEL_ID" \
  --served-name "$ALIAS" \
  --gpu-layers "$NGL" \
  --binary "$LLAMA_BIN" \
  --weights "$WEIGHTS" \
  --output "$ATTESTATION_PATH"

if [[ "$OWNS_LIFECYCLE_LOCK" == "true" ]]; then
  LAUNCHER_PID=$$
  (
    set +e
    for _ in $(seq 1 180); do
      if ! kill -0 "$LAUNCHER_PID" 2>/dev/null; then
        flock -u "$LIFECYCLE_LOCK_FD"
        exit 0
      fi
      if curl -sf "http://$HOST:$PORT/v1/models" >/dev/null 2>&1 && \
        INDIGO_LLM_MODE=local \
        INDIGO_LLM_REQUIRE_GPU=true \
        INDIGO_LLM_MODEL_ID="$MODEL_ID" \
        INDIGO_LLM_MODEL_SHA256=03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8 \
        INDIGO_LLM_ENDPOINT="http://$HOST:$PORT/v1" \
        INDIGO_LLM_TIMEOUT_MS=3000 \
        INDIGO_LLM_MODELS_DIR="$ROOT/llm/models" \
        INDIGO_LLM_WEIGHTS_DIR="$ROOT/llm/weights" \
        INDIGO_LLM_ATTESTATION_PATH="$ATTESTATION_PATH" \
        node --import tsx scripts/llm/preflight.ts --json >/dev/null 2>&1; then
        flock -u "$LIFECYCLE_LOCK_FD"
        exit 0
      fi
      sleep 1
    done
    echo "ERROR: runtime handoff is still unverified after 180 seconds; retaining lifecycle lock until PID $LAUNCHER_PID exits" >&2
    indigo_hold_llm_lifecycle_lock_until_exit \
      "$LAUNCHER_PID" \
      "$LIFECYCLE_LOCK_FD"
  ) &
fi

echo "Starting GPU llama-server"
echo "  bin=$LLAMA_BIN"
echo "  model=$WEIGHTS alias=$ALIAS host=$HOST port=$PORT ngl=$NGL ctx=$CTX"
# This is intentionally after attestation hashing and immediately before process
# launch. Every supported start therefore has exact artifact bytes + 4 GiB free.
indigo_assert_llm_model_load_memory "$ROOT"
exec "$LLAMA_BIN" \
  --model "$WEIGHTS" \
  --host "$HOST" \
  --port "$PORT" \
  --alias "$ALIAS" \
  --n-gpu-layers "$NGL" \
  -c "$CTX" \
  --temp 0.3 \
  --top-p 0.8 \
  --top-k 20 \
  --min-p 0.00 \
  --reasoning off
