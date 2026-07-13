#!/usr/bin/env bash
# Archive one product-path measurement sample:
#   offline baseline + live probe + pnpm test:e2e:llm
#
# Writes under tmp/llm-runs/ (gitignored). Prefer ≥3 independent runs with the
# same modelContentDigest before treating the GPU History path as calibrated.
#
# Prerequisites:
#   - .env.e2e.local configured
#   - GPU healthy + loopback llama-server (pnpm llm:serve)
#
# Usage:
#   pnpm llm:archive-product-path
#   RUNS=3 pnpm llm:archive-product-path
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

export INDIGO_LLM_REQUIRE_GPU="${INDIGO_LLM_REQUIRE_GPU:-true}"
export INDIGO_LLM_ENDPOINT="${INDIGO_LLM_ENDPOINT:-http://127.0.0.1:8080/v1}"
export INDIGO_LLM_MODEL_ID="${INDIGO_LLM_MODEL_ID:-qwen3.5-9b-q4_k_m}"
export INDIGO_LLM_MODEL_SHA256="${INDIGO_LLM_MODEL_SHA256:-03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8}"
export INDIGO_LLM_TIMEOUT_MS="${INDIGO_LLM_TIMEOUT_MS:-60000}"
export INDIGO_LLM_LIVE=1

RUNS="${RUNS:-1}"
ARCHIVE_DIR="${INDIGO_LLM_ARCHIVE_DIR:-$ROOT/tmp/llm-runs}"
mkdir -p "$ARCHIVE_DIR"

if ! curl -sf "$INDIGO_LLM_ENDPOINT/models" >/dev/null 2>&1 \
  && ! curl -sf "${INDIGO_LLM_ENDPOINT%/v1}/v1/models" >/dev/null 2>&1; then
  # Endpoint may already include /v1
  if ! curl -sf "${INDIGO_LLM_ENDPOINT}" >/dev/null 2>&1; then
    # Final try standard models path
    if ! curl -sf "http://127.0.0.1:8080/v1/models" >/dev/null 2>&1; then
      echo "ERROR: loopback model server not reachable (set INDIGO_LLM_ENDPOINT; run pnpm llm:serve)" >&2
      exit 2
    fi
  fi
fi

echo "=== LLM product-path archive (runs=$RUNS) → $ARCHIVE_DIR ==="

for i in $(seq 1 "$RUNS"); do
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  RUN_ID="product-path-${STAMP}-r${i}"
  BASE_JSON="$ARCHIVE_DIR/${RUN_ID}-baseline.json"
  E2E_LOG="$ARCHIVE_DIR/${RUN_ID}-e2e.log"
  META_JSON="$ARCHIVE_DIR/${RUN_ID}.json"

  echo ""
  echo "--- run $i/$RUNS id=$RUN_ID ---"
  echo "1) offline + live baseline"
  # Call node directly so stdout is pure JSON (pnpm wraps scripts with banners).
  INDIGO_LLM_LIVE=1 node --import tsx scripts/llm/validate-baseline.ts --json >"$BASE_JSON"

  echo "2) product e2e (GPU History Explain)"
  E2E_START_MS="$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')"
  set +e
  pnpm test:e2e:llm >"$E2E_LOG" 2>&1
  E2E_CODE=$?
  set -e
  E2E_END_MS="$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')"
  E2E_DURATION_MS=$((E2E_END_MS - E2E_START_MS))
  E2E_OK_PY=False
  if [[ "$E2E_CODE" -eq 0 ]]; then
    E2E_OK_PY=True
  fi

  python3 - <<PY
import json
import sys
from pathlib import Path

raw = Path("$BASE_JSON").read_text()
start = raw.find("{")
if start < 0:
    print("baseline output is not JSON", file=sys.stderr)
    raise SystemExit(1)
base = json.loads(raw[start:])
e2e_ok = $E2E_OK_PY
base["product"] = {
    "e2eOk": e2e_ok,
    "e2eDurationMs": $E2E_DURATION_MS,
    "suite": "test:e2e:llm",
    "note": "archive-product-path run $i/$RUNS; e2e log=$E2E_LOG",
    "e2eExitCode": $E2E_CODE,
}
base["archive"] = {
    "runId": "$RUN_ID",
    "modelId": "${INDIGO_LLM_MODEL_ID}",
    "modelContentDigest": "${INDIGO_LLM_MODEL_SHA256}",
    "endpoint": "${INDIGO_LLM_ENDPOINT}",
}
Path("$META_JSON").write_text(json.dumps(base, indent=2) + "\n")
print("wrote", "$META_JSON")
live = base.get("live") or {}
lat = live.get("latencyMs") or {}
print(
    "offline.ok=", base["offline"]["ok"],
    "live.availableRate=", live.get("availableRate"),
    "live.latencyMs.p50=", lat.get("p50"),
    "live.latencyMs.p95=", lat.get("p95"),
    "product.e2eOk=", e2e_ok,
    "product.e2eDurationMs=", $E2E_DURATION_MS,
)
if not base["offline"]["ok"]:
    raise SystemExit(1)
if live.get("availableRate") not in (1, 1.0):
    print("WARNING: live availableRate is not 1.0", file=sys.stderr)
if not e2e_ok:
    print("e2e failed; see", "$E2E_LOG", file=sys.stderr)
    raise SystemExit(1)
PY
done

echo ""
echo "=== archive complete under $ARCHIVE_DIR ==="
ls -1t "$ARCHIVE_DIR"/product-path-*.json | head -10
