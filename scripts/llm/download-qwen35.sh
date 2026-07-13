#!/usr/bin/env bash
# Download Qwen3.5-9B Q4_K_M GGUF into llm/weights for the Indigo pack.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${INDIGO_LLM_WEIGHTS_DIR:-$ROOT/llm/weights}"
mkdir -p "$OUT_DIR"
LOCK="$ROOT/llm/models/qwen3.5-9b-q4_k_m/artifact.lock.json"
REPO="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).repository" "$LOCK")"
REVISION="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).revision" "$LOCK")"
FILENAME="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).filename" "$LOCK")"
INSTALLED_FILENAME="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).installedFilename" "$LOCK")"
EXPECTED_SHA256="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).sha256" "$LOCK")"
EXPECTED_SIZE="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).sizeBytes" "$LOCK")"
TARGET="$OUT_DIR/$INSTALLED_FILENAME"

verify_artifact() {
  local path="$1"
  local size digest
  size="$(stat -c '%s' "$path")"
  digest="$(sha256sum "$path" | cut -d ' ' -f 1)"
  if [[ "$size" != "$EXPECTED_SIZE" ]]; then
    echo "FATAL: size $size does not match artifact lock $EXPECTED_SIZE" >&2
    return 1
  fi
  if [[ "$digest" != "$EXPECTED_SHA256" ]]; then
    echo "FATAL: SHA-256 $digest does not match artifact lock $EXPECTED_SHA256" >&2
    return 1
  fi
  printf '%s  %s\n' "$digest" "$TARGET" > "$TARGET.sha256"
}

if [[ -f "$TARGET" && "${FORCE:-}" != "1" ]]; then
  verify_artifact "$TARGET"
  echo "Already present: $TARGET"
  ls -lh "$TARGET"
  exit 0
fi

if ! command -v hf >/dev/null 2>&1; then
  echo "FATAL: Hugging Face CLI 'hf' is required (install huggingface_hub)." >&2
  exit 1
fi

echo "Downloading $REPO/$FILENAME at revision $REVISION → $TARGET"
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

hf download "$REPO" "$FILENAME" \
  --revision "$REVISION" \
  --local-dir "$TMP"

FILE="$TMP/$FILENAME"
if [[ ! -f "$FILE" ]]; then
  echo "FATAL: exact locked artifact was not downloaded: $FILE" >&2
  exit 1
fi

verify_artifact "$FILE"
install -m 0644 "$FILE" "$TARGET.tmp"
mv -f "$TARGET.tmp" "$TARGET"
verify_artifact "$TARGET"
ls -lh "$TARGET"
echo "Verified SHA-256: $EXPECTED_SHA256"
