#!/usr/bin/env bash
# Download Qwen3.5-9B Q4_K_M GGUF into llm/weights for the Indigo pack.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${INDIGO_LLM_WEIGHTS_DIR:-$ROOT/llm/weights}"
mkdir -p "$OUT_DIR"
TARGET="$OUT_DIR/qwen3.5-9b-q4_k_m.gguf"

if [[ -f "$TARGET" && "${FORCE:-}" != "1" ]]; then
  echo "Already present: $TARGET"
  ls -lh "$TARGET"
  sha256sum "$TARGET" | tee "$OUT_DIR/qwen3.5-9b-q4_k_m.gguf.sha256"
  exit 0
fi

echo "Downloading unsloth/Qwen3.5-9B-GGUF Q4_K_M → $TARGET"
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

if command -v hf >/dev/null 2>&1; then
  hf download unsloth/Qwen3.5-9B-GGUF \
    --local-dir "$TMP" \
    --include '*Q4_K_M*.gguf'
elif command -v huggingface-cli >/dev/null 2>&1; then
  huggingface-cli download unsloth/Qwen3.5-9B-GGUF \
    --local-dir "$TMP" \
    --include '*Q4_K_M*.gguf'
else
  echo "Need hf or huggingface-cli on PATH" >&2
  exit 1
fi

FILE="$(find "$TMP" -type f -name '*Q4_K_M*.gguf' | head -1)"
if [[ -z "$FILE" ]]; then
  echo "Download finished but no Q4_K_M GGUF found under $TMP" >&2
  find "$TMP" -type f | head -50 >&2
  exit 1
fi

cp -f "$FILE" "$TARGET"
sha256sum "$TARGET" | tee "$OUT_DIR/qwen3.5-9b-q4_k_m.gguf.sha256"
ls -lh "$TARGET"
echo "Done. Set INDIGO_LLM_MODEL_SHA256 to the digest above for cache identity."
