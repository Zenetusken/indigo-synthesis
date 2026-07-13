#!/usr/bin/env bash
# Post-reboot GPU measurement for the Indigo LLM layer.
# Requires healthy nvidia-smi, CUDA llama-server, and pack weights.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

export INDIGO_LLM_REQUIRE_GPU=true
export INDIGO_LLM_MODE=local
export INDIGO_LLM_N_GPU_LAYERS=all
export INDIGO_LLM_ENDPOINT=http://127.0.0.1:8080/v1
export INDIGO_LLM_MODEL_ID=qwen3.5-9b-q4_k_m
export INDIGO_LLM_MODEL_SHA256=03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8
export INDIGO_LLM_ATTESTATION_PATH="${INDIGO_LLM_ATTESTATION_PATH:-$ROOT/tmp/llm-runtime-attestation.json}"
export INDIGO_LLM_TIMEOUT_MS=3000
export INDIGO_LLM_MODELS_DIR="$ROOT/llm/models"
export INDIGO_LLM_WEIGHTS_DIR="$ROOT/llm/weights"
export INDIGO_LLAMA_SERVER="${INDIGO_LLAMA_SERVER:-$HOME/project/llama.cpp-indigo/build/bin/llama-server}"
export PATH="$(dirname "$INDIGO_LLAMA_SERVER"):$PATH"

export INDIGO_LLM_HOST=127.0.0.1
export INDIGO_LLM_PORT=8080

echo "=== 1) GPU health ==="
nvidia-smi
echo "Loaded module: $(cat /sys/module/nvidia/version)"
echo "MemAvailable: $(awk '/MemAvailable/ {printf \"%.1f GiB\\n\", $2/1024/1024}' /proc/meminfo)"

echo "=== 2) Ensure pinned CUDA llama-server binary ==="
LOCKED_BINARY_SHA256="$(node -p "JSON.parse(require('fs').readFileSync('llm/runtime/llama-cpp.lock.json', 'utf8')).serverBinarySha256")"
ACTUAL_BINARY_SHA256="$(sha256sum "$INDIGO_LLAMA_SERVER" 2>/dev/null | cut -d ' ' -f 1 || true)"
RUNTIME_MATCH=true
if [[ ! -x "$INDIGO_LLAMA_SERVER" ]] || [[ "$ACTUAL_BINARY_SHA256" != "$LOCKED_BINARY_SHA256" ]]; then
  RUNTIME_MATCH=false
fi
RUNTIME_DIRECTORY="$(dirname "$INDIGO_LLAMA_SERVER")"
while IFS=$'\t' read -r LIBRARY_FILENAME LIBRARY_SHA256 LIBRARY_SIZE; do
  LIBRARY_PATH="$RUNTIME_DIRECTORY/$LIBRARY_FILENAME"
  ACTUAL_LIBRARY_SHA256="$(sha256sum "$LIBRARY_PATH" 2>/dev/null | cut -d ' ' -f 1 || true)"
  ACTUAL_LIBRARY_SIZE="$(stat -c '%s' "$LIBRARY_PATH" 2>/dev/null || true)"
  if [[ "$ACTUAL_LIBRARY_SHA256" != "$LIBRARY_SHA256" || "$ACTUAL_LIBRARY_SIZE" != "$LIBRARY_SIZE" ]]; then
    RUNTIME_MATCH=false
  fi
done < <(
  node -e "const lock=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); for (const lib of lock.runtimeLibraries) console.log([lib.filename,lib.sha256,lib.sizeBytes].join('\\t'))" "llm/runtime/llama-cpp.lock.json"
)
if [[ "$RUNTIME_MATCH" != "true" ]]; then
  echo "Building/rebuilding CUDA llama-server..."
  bash scripts/llm/build-cuda-server.sh
fi

echo "=== 3) Stop only a matching prior listener on :8080 ==="
if ! command -v lsof >/dev/null 2>&1; then
  echo "FATAL: lsof is required to verify listener ownership safely" >&2
  exit 2
fi
LISTENER_PID="$(lsof -t -iTCP:8080 -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [[ -n "$LISTENER_PID" ]]; then
  LISTENER_EXE="$(readlink -f "/proc/$LISTENER_PID/exe" 2>/dev/null || true)"
  EXPECTED_EXE="$(readlink -f "$INDIGO_LLAMA_SERVER")"
  LISTENER_COMMAND="$(tr '\0' ' ' < "/proc/$LISTENER_PID/cmdline" 2>/dev/null || true)"
  if [[ "$LISTENER_EXE" != "$EXPECTED_EXE" || "$LISTENER_COMMAND" != *"qwen3.5-9b-q4_k_m.gguf"* ]]; then
    echo "FATAL: :8080 is owned by an unrelated process; refusing to kill PID $LISTENER_PID" >&2
    exit 2
  fi
  kill "$LISTENER_PID"
  for _ in $(seq 1 20); do
    kill -0 "$LISTENER_PID" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$LISTENER_PID" 2>/dev/null; then
    echo "FATAL: prior matching listener PID $LISTENER_PID did not stop" >&2
    exit 2
  fi
fi
if [[ -n "$(lsof -t -iTCP:8080 -sTCP:LISTEN 2>/dev/null || true)" ]]; then
  echo "FATAL: :8080 is still occupied after the owned-listener stop" >&2
  exit 2
fi

echo "=== 4) Start pinned GPU server (background) ==="
LOG=/tmp/indigo-llama-gpu.log
nohup bash scripts/llm/serve-local.sh >"$LOG" 2>&1 &
SERVER_PID=$!
echo "server pid=$SERVER_PID log=$LOG"

SERVER_READY=false
for i in $(seq 1 90); do
  if curl -sf http://127.0.0.1:8080/v1/models >/dev/null 2>&1; then
    echo "server ready after ${i}s"
    SERVER_READY=true
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "server died; log:" >&2
    tail -50 "$LOG" >&2
    exit 1
  fi
  sleep 2
done
if [[ "$SERVER_READY" != "true" ]]; then
  echo "FATAL: pinned server did not become ready before the deadline" >&2
  tail -50 "$LOG" >&2
  exit 2
fi

ATTESTED_PID="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).pid" "$INDIGO_LLM_ATTESTATION_PATH")"
if [[ "$ATTESTED_PID" != "$SERVER_PID" ]]; then
  echo "FATAL: ready runtime PID $SERVER_PID does not match attestation PID $ATTESTED_PID" >&2
  exit 2
fi

curl -sS http://127.0.0.1:8080/v1/models | head -c 400
echo

echo "=== 5) Product readiness preflight ==="
pnpm llm:preflight

echo "=== 6) GPU memory after model load ==="
nvidia-smi --query-gpu=memory.used,memory.free,utilization.gpu --format=csv

echo "=== 7) Live baseline measurement (JSON) ==="
OUT="/tmp/indigo-llm-gpu-measure-$(date -u +%Y%m%dT%H%M%SZ).json"
# Invoke the TypeScript entrypoint directly so the archive is pure JSON rather than
# pnpm's command banner followed by JSON.
INDIGO_LLM_LIVE=1 node --import tsx scripts/llm/validate-baseline.ts --json | tee "$OUT"

echo "=== 8) Summary ==="
python3 - <<'PY' "$OUT"
import json,sys
p=json.load(open(sys.argv[1]))
live=p.get("live") or {}
print("offline.ok=", p["offline"]["ok"])
print("live.availableRate=", live.get("availableRate"))
print("live.availableCount=", live.get("availableCount"))
print("live.failureReasons=", live.get("failureReasons"))
print("gpu_measure_file=", sys.argv[1])
if not p["offline"]["ok"]:
    raise SystemExit(2)
if live.get("availableRate") != 1:
    print("WARNING: live availableRate is not 1.0 — inspect JSON", file=sys.stderr)
    raise SystemExit(3)
print("GPU live calibration PASS (availableRate=1.0)")
PY
