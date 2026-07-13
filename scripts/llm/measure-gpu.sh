#!/usr/bin/env bash
# Post-reboot GPU measurement for the Indigo LLM layer.
# Requires healthy nvidia-smi, CUDA llama-server, and pack weights.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

export INDIGO_LLM_REQUIRE_GPU="${INDIGO_LLM_REQUIRE_GPU:-true}"
export INDIGO_LLM_N_GPU_LAYERS="${INDIGO_LLM_N_GPU_LAYERS:--1}"
export INDIGO_LLM_ENDPOINT="${INDIGO_LLM_ENDPOINT:-http://127.0.0.1:8080/v1}"
export INDIGO_LLM_MODEL_ID="${INDIGO_LLM_MODEL_ID:-qwen3.5-9b-q4_k_m}"
export INDIGO_LLM_MODEL_SHA256="${INDIGO_LLM_MODEL_SHA256:-03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8}"
export INDIGO_LLM_TIMEOUT_MS="${INDIGO_LLM_TIMEOUT_MS:-60000}"
export INDIGO_LLAMA_SERVER="${INDIGO_LLAMA_SERVER:-$HOME/project/llama.cpp-indigo/build/bin/llama-server}"
export PATH="$(dirname "$INDIGO_LLAMA_SERVER"):$PATH"

echo "=== 1) GPU health ==="
nvidia-smi
echo "Loaded module: $(cat /sys/module/nvidia/version)"
echo "MemAvailable: $(awk '/MemAvailable/ {printf \"%.1f GiB\\n\", $2/1024/1024}' /proc/meminfo)"

echo "=== 2) Preflight (must be ready) ==="
pnpm llm:preflight

echo "=== 3) Ensure CUDA llama-server binary ==="
if [[ ! -x "$INDIGO_LLAMA_SERVER" ]] || ! ldd "$INDIGO_LLAMA_SERVER" 2>/dev/null | grep -qi cuda; then
  echo "Building/rebuilding CUDA llama-server..."
  bash scripts/llm/build-cuda-server.sh
fi

echo "=== 4) Stop any CPU-only server on :8080 ==="
pkill -f 'llama-server.*8080' 2>/dev/null || true
sleep 1

echo "=== 5) Start GPU server (background) ==="
LOG=/tmp/indigo-llama-gpu.log
nohup bash scripts/llm/serve-local.sh >"$LOG" 2>&1 &
SERVER_PID=$!
echo "server pid=$SERVER_PID log=$LOG"

for i in $(seq 1 90); do
  if curl -sf http://127.0.0.1:8080/v1/models >/dev/null 2>&1; then
    echo "server ready after ${i}s"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "server died; log:" >&2
    tail -50 "$LOG" >&2
    exit 1
  fi
  sleep 2
done

curl -sS http://127.0.0.1:8080/v1/models | head -c 400
echo

echo "=== 6) GPU memory after model load ==="
nvidia-smi --query-gpu=memory.used,memory.free,utilization.gpu --format=csv

echo "=== 7) Live baseline measurement (JSON) ==="
OUT="/tmp/indigo-llm-gpu-measure-$(date -u +%Y%m%dT%H%M%SZ).json"
INDIGO_LLM_LIVE=1 pnpm llm:validate-baseline --json | tee "$OUT"

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
