#!/usr/bin/env bash
# Start GPU-only loopback llama-server for Indigo's LLM layer.
# Refuses to start if NVIDIA is unhealthy (product policy: no CPU inference).
set -euo pipefail

PORT="${INDIGO_LLM_PORT:-8080}"
HOST="${INDIGO_LLM_HOST:-127.0.0.1}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WEIGHTS="${INDIGO_LLM_WEIGHTS:-$ROOT/llm/weights/qwen3.5-9b-q4_k_m.gguf}"
ALIAS="${INDIGO_LLM_SERVED_NAME:-qwen3.5-9b-q4_k_m}"
CTX="${INDIGO_LLM_CTX:-4096}"
# Product default: offload all layers. Override only for explicit diagnostics.
NGL="${INDIGO_LLM_N_GPU_LAYERS:--1}"
REQUIRE_GPU="${INDIGO_LLM_REQUIRE_GPU:-true}"

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
  if [[ "$REQUIRE_GPU" == "false" || "$REQUIRE_GPU" == "0" ]]; then
    echo "WARNING: INDIGO_LLM_REQUIRE_GPU=false — CPU path allowed for diagnosis only." >&2
    return 0
  fi
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
  if [[ "$NGL" == "0" ]]; then
    echo "FATAL: INDIGO_LLM_N_GPU_LAYERS=0 disables GPU offload; product policy forbids CPU-only serve." >&2
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

echo "Starting GPU llama-server"
echo "  bin=$LLAMA_BIN"
echo "  model=$WEIGHTS alias=$ALIAS host=$HOST port=$PORT ngl=$NGL ctx=$CTX"
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
