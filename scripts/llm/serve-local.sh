#!/usr/bin/env bash
# Start a loopback OpenAI-compatible inference server for Indigo's LLM layer.
# Preference order:
#   1) INDIGO_LLAMA_SERVER or PATH llama-server (supports qwen35 when recent)
#   2) ~/project/llama.cpp-indigo/build/bin/llama-server (operator build)
#   3) LM Studio `lms` (may lack qwen35 — use only for non-pack models)
set -euo pipefail

PORT="${INDIGO_LLM_PORT:-8080}"
HOST="${INDIGO_LLM_HOST:-127.0.0.1}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WEIGHTS="${INDIGO_LLM_WEIGHTS:-$ROOT/llm/weights/qwen3.5-9b-q4_k_m.gguf}"
ALIAS="${INDIGO_LLM_SERVED_NAME:-qwen3.5-9b-q4_k_m}"
CTX="${INDIGO_LLM_CTX:-4096}"

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

gpu_layers() {
  if [[ -n "${INDIGO_LLM_N_GPU_LAYERS:-}" ]]; then
    echo "$INDIGO_LLM_N_GPU_LAYERS"
    return
  fi
  if nvidia-smi >/dev/null 2>&1; then
    echo "-1"
  else
    echo "0"
  fi
}

if LLAMA_BIN="$(resolve_llama_server)"; then
  if [[ ! -f "$WEIGHTS" ]]; then
    echo "Weights not found at $WEIGHTS — run: pnpm llm:download-qwen35" >&2
    exit 1
  fi
  NGL="$(gpu_layers)"
  echo "Starting $LLAMA_BIN"
  echo "  model=$WEIGHTS alias=$ALIAS host=$HOST port=$PORT ngl=$NGL ctx=$CTX"
  if [[ "$NGL" == "0" ]]; then
    echo "  note: CPU-only (GPU unavailable or INDIGO_LLM_N_GPU_LAYERS=0). After reboot + healthy nvidia-smi, use ngl=-1."
  fi
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
fi

if command -v lms >/dev/null 2>&1; then
  echo "llama-server not found; falling back to LM Studio on port 1234."
  echo "Warning: older LM Studio runtimes may not support architecture 'qwen35'."
  lms server start || true
  sleep 1
  if curl -sf "http://127.0.0.1:1234/v1/models" >/dev/null; then
    echo "LM Studio reachable at http://127.0.0.1:1234/v1"
    exit 0
  fi
  exit 1
fi

echo "Neither llama-server nor lms found." >&2
echo "Build: see docs/architecture/LLM_RUNTIME_AND_GPU.md" >&2
exit 1
