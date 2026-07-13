#!/usr/bin/env bash
# Load the Indigo pack model into LM Studio (loopback server).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WEIGHTS="${INDIGO_LLM_WEIGHTS:-$ROOT/llm/weights/qwen3.5-9b-q4_k_m.gguf}"
USER_REPO="${INDIGO_LLM_LMS_USER_REPO:-indigo/qwen3.5-9b-q4_k_m}"
IDENTIFIER="${INDIGO_LLM_SERVED_NAME:-qwen3.5-9b-q4_k_m}"
# off until GPU preflight is ready; set INDIGO_LLM_GPU=max after reboot + healthy nvidia-smi
GPU_MODE="${INDIGO_LLM_GPU:-off}"
CTX="${INDIGO_LLM_CTX:-4096}"

if ! command -v lms >/dev/null 2>&1; then
  echo "lms not found — with llama-server the weights are loaded at process start." >&2
  exit 0
fi

lms server start >/dev/null 2>&1 || true

if [[ -f "$WEIGHTS" ]]; then
  echo "Ensuring LM Studio catalog entry for $WEIGHTS ($USER_REPO)..."
  lms import "$WEIGHTS" -y --symbolic-link --user-repo "$USER_REPO" 2>/dev/null \
    || lms import "$WEIGHTS" -y --hard-link --user-repo "$USER_REPO" 2>/dev/null \
    || true
fi

echo "Loading $USER_REPO as identifier=$IDENTIFIER gpu=$GPU_MODE ctx=$CTX"
if ! lms load "$USER_REPO" -y --gpu "$GPU_MODE" --identifier "$IDENTIFIER" --context-length "$CTX"; then
  echo "Primary load failed; trying path match qwen3.5-9b..." >&2
  lms load qwen3.5-9b -y --gpu "$GPU_MODE" --identifier "$IDENTIFIER" --context-length "$CTX" || {
    echo "Could not load Qwen3.5-9B. Is the GGUF imported? Run: pnpm llm:download-qwen35" >&2
    echo "Falling back to qwen2.5-7b-instruct-1m for endpoint smoke only." >&2
    lms load qwen2.5-7b-instruct-1m -y --gpu "$GPU_MODE" --identifier qwen2.5-7b-instruct-1m --context-length "$CTX" || true
  }
fi

echo "Server models:"
curl -sS http://127.0.0.1:1234/v1/models || true
echo
lms ps 2>/dev/null || true
