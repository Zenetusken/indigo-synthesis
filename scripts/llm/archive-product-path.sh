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
source scripts/lib/host-lock.sh

if ! command -v flock >/dev/null 2>&1; then
  echo "ERROR: flock is required to protect calibrated archive measurements" >&2
  exit 2
fi
ARCHIVE_LOCK="$(indigo_host_lock_dir)/llm-archive.lock"
exec 8>"$ARCHIVE_LOCK"
if ! flock -n 8; then
  echo "ERROR: another LLM product-path archive is active ($ARCHIVE_LOCK)" >&2
  exit 75
fi

export INDIGO_LLM_REQUIRE_GPU=true
export INDIGO_LLM_MODE=local
export INDIGO_LLM_N_GPU_LAYERS=all
export INDIGO_LLM_ENDPOINT=http://127.0.0.1:8080/v1
export INDIGO_LLM_MODEL_ID=qwen3.5-9b-q4_k_m
export INDIGO_LLM_MODEL_SHA256=03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8
export INDIGO_LLM_TIMEOUT_MS=3000
export INDIGO_LLM_MODELS_DIR="$ROOT/llm/models"
export INDIGO_LLM_WEIGHTS_DIR="$ROOT/llm/weights"
export INDIGO_LLM_LIVE=1

RUNS="${RUNS:-3}"
ARCHIVE_DIR="${INDIGO_LLM_ARCHIVE_DIR:-$ROOT/tmp/llm-runs}"
mkdir -p "$ARCHIVE_DIR"

if ! [[ "$RUNS" =~ ^[0-9]+$ ]] || (( RUNS < 3 )); then
  echo "ERROR: a calibrated product-path archive requires RUNS >= 3" >&2
  exit 2
fi

echo "=== LLM product-path archive (runs=$RUNS) → $ARCHIVE_DIR ==="
BATCH_LIST="$ARCHIVE_DIR/archive-batch-$(date -u +%Y%m%dT%H%M%SZ)-$$.list"
: >"$BATCH_LIST"

for i in $(seq 1 "$RUNS"); do
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  RUN_ID="product-path-${STAMP}-p$$-r${i}"
  BASE_JSON="$ARCHIVE_DIR/${RUN_ID}-baseline.json"
  E2E_LOG="$ARCHIVE_DIR/${RUN_ID}-e2e.log"
  META_JSON="$ARCHIVE_DIR/${RUN_ID}.json"
  PREFLIGHT_JSON="$ARCHIVE_DIR/${RUN_ID}-preflight-before.json"
  POST_PREFLIGHT_JSON="$ARCHIVE_DIR/${RUN_ID}-preflight-after.json"

  echo ""
  echo "--- run $i/$RUNS id=$RUN_ID ---"
  echo "1) pinned runtime preflight"
  node --import tsx scripts/llm/preflight.ts --json >"$PREFLIGHT_JSON"

  echo "2) offline + live baseline"
  # Call node directly so stdout is pure JSON (pnpm wraps scripts with banners).
  INDIGO_LLM_LIVE=1 node --import tsx scripts/llm/validate-baseline.ts --json >"$BASE_JSON"

  echo "3) product e2e (GPU History Explain)"
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

  echo "4) post-run runtime identity check"
  node --import tsx scripts/llm/preflight.ts --json >"$POST_PREFLIGHT_JSON"

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
    "preflightBeforeFile": "$PREFLIGHT_JSON",
    "preflightAfterFile": "$POST_PREFLIGHT_JSON",
}
preflight = json.loads(Path("$PREFLIGHT_JSON").read_text())
post_preflight = json.loads(Path("$POST_PREFLIGHT_JSON").read_text())
identity = preflight.get("verifiedRuntimeIdentity") or {}
post_identity = post_preflight.get("verifiedRuntimeIdentity") or {}
base["archive"]["runtimeId"] = identity.get("runtimeId")
base["archive"]["runtimeAttestationDigest"] = identity.get("runtimeAttestationDigest")
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
    print("live availableRate is not 1.0", file=sys.stderr)
    raise SystemExit(1)
if lat.get("p95") is None or lat["p95"] > 3500:
    print("live p95 exceeds the 3s interactive budget plus measurement tolerance", file=sys.stderr)
    raise SystemExit(1)
if not base["archive"]["runtimeAttestationDigest"]:
    print("runtime attestation digest missing", file=sys.stderr)
    raise SystemExit(1)
if identity != post_identity:
    print("runtime identity changed during the product-path run", file=sys.stderr)
    raise SystemExit(1)
if not e2e_ok:
    print("e2e failed; see", "$E2E_LOG", file=sys.stderr)
    raise SystemExit(1)
PY
  printf '%s\n' "$META_JSON" >>"$BATCH_LIST"
done

python3 - <<PY
import json
from pathlib import Path

paths = [Path(line) for line in Path("$BATCH_LIST").read_text().splitlines() if line]
if len(paths) != $RUNS:
    raise SystemExit("archive set is incomplete")
rows = [json.loads(path.read_text()) for path in paths]
digests = {row["archive"]["modelContentDigest"] for row in rows}
attestations = {row["archive"]["runtimeAttestationDigest"] for row in rows}
baselines = {row["baselineVersion"] for row in rows}
if len(digests) != 1 or len(attestations) != 1 or len(baselines) != 1:
    raise SystemExit("archive identity drifted across runs")
if not all(row.get("product", {}).get("e2eOk") for row in rows):
    raise SystemExit("one or more product-path runs failed")
print("verified calibrated archive set:", ", ".join(path.name for path in paths))
PY

echo ""
echo "=== archive complete under $ARCHIVE_DIR ==="
while IFS= read -r META_PATH; do
  echo "$META_PATH"
done <"$BATCH_LIST"
