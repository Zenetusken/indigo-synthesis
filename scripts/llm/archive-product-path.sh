#!/usr/bin/env bash
# Archive a calibrated product-path measurement batch:
#   offline baseline + live probe + pnpm test:e2e:llm
#
# Writes under tmp/llm-runs/ (gitignored). Prefer ≥3 independent runs with the
# same source commit/tree and model/runtime identities before treating the GPU
# History path as calibrated.
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

if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git is required to pin archive evidence to reviewed source" >&2
  exit 2
fi

GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "ERROR: the LLM product-path archive must run from a Git worktree" >&2
  exit 2
}
if [[ "$(cd "$GIT_ROOT" && pwd)" != "$ROOT" ]]; then
  echo "ERROR: archive script root ($ROOT) is not the Git worktree root ($GIT_ROOT)" >&2
  exit 2
fi

SOURCE_COMMIT="$(git rev-parse --verify 'HEAD^{commit}')"
SOURCE_TREE="$(git rev-parse --verify "${SOURCE_COMMIT}^{tree}")"

assert_source_identity() {
  local phase="$1"
  local current_commit
  local current_tree
  local source_status

  current_commit="$(git rev-parse --verify 'HEAD^{commit}')" || {
    echo "ERROR: cannot resolve source commit during $phase" >&2
    return 2
  }
  current_tree="$(git rev-parse --verify "${current_commit}^{tree}")" || {
    echo "ERROR: cannot resolve source tree during $phase" >&2
    return 2
  }
  source_status="$(git status --porcelain=v1 --untracked-files=all)" || {
    echo "ERROR: cannot inspect source worktree during $phase" >&2
    return 2
  }

  if [[ -n "$source_status" ]]; then
    echo "ERROR: calibrated archives require a clean tracked and untracked worktree ($phase)" >&2
    printf '%s\n' "$source_status" >&2
    return 2
  fi
  if [[ "$current_commit" != "$SOURCE_COMMIT" || "$current_tree" != "$SOURCE_TREE" ]]; then
    echo "ERROR: source identity changed during archive ($phase)" >&2
    echo "expected commit=$SOURCE_COMMIT tree=$SOURCE_TREE" >&2
    echo "actual   commit=$current_commit tree=$current_tree" >&2
    return 2
  fi
}

assert_ready_preflight_file() {
  local path="$1"
  local phase="$2"
  python3 - "$path" "$phase" <<'PY'
import json
import sys
from pathlib import Path

path, phase = sys.argv[1:]
report = json.loads(Path(path).read_text())
if report.get("readyForLocalInference") is not True:
    print(f"runtime preflight {phase} is not ready", file=sys.stderr)
    raise SystemExit(1)
if (report.get("runtimeEvidence") or {}).get("state") != "verified":
    print(f"runtime preflight {phase} is not verified", file=sys.stderr)
    raise SystemExit(1)
if not report.get("verifiedRuntimeIdentity"):
    print(f"runtime preflight {phase} has no verified identity", file=sys.stderr)
    raise SystemExit(1)
PY
}

assert_source_identity "archive start"

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
umask 077

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

if ! [[ "$RUNS" =~ ^[0-9]+$ ]] || (( RUNS < 3 )); then
  echo "ERROR: a calibrated product-path archive requires RUNS >= 3" >&2
  exit 2
fi

mkdir -p "$ARCHIVE_DIR"
BATCH_ID="archive-batch-$(date -u +%Y%m%dT%H%M%SZ)-$$"
BATCH_LIST="$ARCHIVE_DIR/${BATCH_ID}.list"
BATCH_MANIFEST="$ARCHIVE_DIR/${BATCH_ID}.json"

echo "=== LLM product-path archive (runs=$RUNS) → $ARCHIVE_DIR ==="
echo "source commit=$SOURCE_COMMIT tree=$SOURCE_TREE"
: >"$BATCH_LIST"

for i in $(seq 1 "$RUNS"); do
  assert_source_identity "before run $i/$RUNS"

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
  assert_ready_preflight_file "$PREFLIGHT_JSON" "before run"

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

  echo "4) post-run runtime identity check"
  node --import tsx scripts/llm/preflight.ts --json >"$POST_PREFLIGHT_JSON"
  assert_ready_preflight_file "$POST_PREFLIGHT_JSON" "after run"
  assert_source_identity "after run $i/$RUNS"

  python3 - \
    "$BASE_JSON" \
    "$E2E_LOG" \
    "$META_JSON" \
    "$PREFLIGHT_JSON" \
    "$POST_PREFLIGHT_JSON" \
    "$RUN_ID" \
    "$i" \
    "$RUNS" \
    "$E2E_CODE" \
    "$E2E_DURATION_MS" \
    "$INDIGO_LLM_MODEL_ID" \
    "$INDIGO_LLM_MODEL_SHA256" \
    "$INDIGO_LLM_ENDPOINT" \
    "$SOURCE_COMMIT" \
    "$SOURCE_TREE" <<'PY'
import json
import os
import sys
from pathlib import Path

(
    base_json,
    e2e_log,
    meta_json,
    preflight_json,
    post_preflight_json,
    run_id,
    run_index,
    run_count,
    e2e_code_raw,
    e2e_duration_ms_raw,
    model_id,
    model_digest,
    endpoint,
    source_commit,
    source_tree,
) = sys.argv[1:]
e2e_code = int(e2e_code_raw)
e2e_duration_ms = int(e2e_duration_ms_raw)
e2e_ok = e2e_code == 0

def write_json_atomic(path_raw, payload):
    path = Path(path_raw)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temporary.write_text(json.dumps(payload, indent=2) + "\n")
    temporary.replace(path)


raw = Path(base_json).read_text()
start = raw.find("{")
if start < 0:
    print("baseline output is not JSON", file=sys.stderr)
    raise SystemExit(1)
baseline_evidence = json.loads(raw[start:])
base = dict(baseline_evidence)
base["product"] = {
    "e2eOk": e2e_ok,
    "e2eDurationMs": e2e_duration_ms,
    "suite": "test:e2e:llm",
    "note": f"archive-product-path run {run_index}/{run_count}; e2e log={e2e_log}",
    "e2eExitCode": e2e_code,
}
base["archive"] = {
    "status": "verified",
    "runId": run_id,
    "sourceCommit": source_commit,
    "sourceTree": source_tree,
    "sourceWorktree": "clean",
    "modelId": model_id,
    "modelContentDigest": model_digest,
    "endpoint": endpoint,
    "preflightBeforeFile": preflight_json,
    "preflightAfterFile": post_preflight_json,
}
preflight = json.loads(Path(preflight_json).read_text())
post_preflight = json.loads(Path(post_preflight_json).read_text())
identity = preflight.get("verifiedRuntimeIdentity") or {}
post_identity = post_preflight.get("verifiedRuntimeIdentity") or {}
for phase, report in (("before", preflight), ("after", post_preflight)):
    if report.get("readyForLocalInference") is not True:
        print(f"runtime preflight {phase} run is not ready", file=sys.stderr)
        raise SystemExit(1)
    if (report.get("runtimeEvidence") or {}).get("state") != "verified":
        print(f"runtime preflight {phase} run is not verified", file=sys.stderr)
        raise SystemExit(1)
base["archive"]["runtimeId"] = identity.get("runtimeId")
base["archive"]["runtimeAttestationDigest"] = identity.get("runtimeAttestationDigest")
live = base.get("live") or {}
lat = live.get("latencyMs") or {}
print(
    "offline.ok=", base["offline"]["ok"],
    "live.availableRate=", live.get("availableRate"),
    "live.latencyMs.p50=", lat.get("p50"),
    "live.latencyMs.p95=", lat.get("p95"),
    "product.e2eOk=", e2e_ok,
    "product.e2eDurationMs=", e2e_duration_ms,
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
    print("e2e failed; see", e2e_log, file=sys.stderr)
    raise SystemExit(1)
source_evidence = {
    "commit": source_commit,
    "tree": source_tree,
    "worktree": "clean",
}
baseline_evidence["archiveSource"] = {
    **source_evidence,
    "evidenceKind": "baseline",
}
preflight["archiveSource"] = {
    **source_evidence,
    "evidenceKind": "preflight-before",
}
post_preflight["archiveSource"] = {
    **source_evidence,
    "evidenceKind": "preflight-after",
}
base["archiveSource"] = {
    **source_evidence,
    "evidenceKind": "product-path-summary",
}
write_json_atomic(base_json, baseline_evidence)
write_json_atomic(preflight_json, preflight)
write_json_atomic(post_preflight_json, post_preflight)
write_json_atomic(meta_json, base)
print("wrote", meta_json)
PY
  printf '%s\n' "$META_JSON" >>"$BATCH_LIST"
done

assert_source_identity "before batch verification"

python3 - \
  "$BATCH_LIST" \
  "$BATCH_MANIFEST" \
  "$BATCH_ID" \
  "$RUNS" \
  "$SOURCE_COMMIT" \
  "$SOURCE_TREE" <<'PY'
import json
import os
import sys
from pathlib import Path

batch_list, batch_manifest, batch_id, run_count_raw, source_commit, source_tree = sys.argv[1:]
run_count = int(run_count_raw)
paths = [Path(line) for line in Path(batch_list).read_text().splitlines() if line]
if len(paths) != run_count:
    raise SystemExit("archive set is incomplete")
rows = [json.loads(path.read_text()) for path in paths]
digests = {row["archive"]["modelContentDigest"] for row in rows}
attestations = {row["archive"]["runtimeAttestationDigest"] for row in rows}
baselines = {row["baselineVersion"] for row in rows}
source_commits = {row["archive"]["sourceCommit"] for row in rows}
source_trees = {row["archive"]["sourceTree"] for row in rows}
model_ids = {row["archive"]["modelId"] for row in rows}
endpoints = {row["archive"]["endpoint"] for row in rows}
runtime_ids = {row["archive"]["runtimeId"] for row in rows}
run_ids = {row["archive"]["runId"] for row in rows}
if (
    len(digests) != 1
    or len(attestations) != 1
    or len(baselines) != 1
    or len(model_ids) != 1
    or len(endpoints) != 1
    or len(runtime_ids) != 1
    or len(run_ids) != run_count
    or source_commits != {source_commit}
    or source_trees != {source_tree}
):
    raise SystemExit("archive identity drifted across runs")
for row in rows:
    archive = row.get("archive") or {}
    archive_source = row.get("archiveSource") or {}
    live = row.get("live") or {}
    latency = live.get("latencyMs") or {}
    if archive.get("status") != "verified" or archive.get("sourceWorktree") != "clean":
        raise SystemExit("one or more run summaries are not verified")
    if archive_source.get("commit") != source_commit or archive_source.get("tree") != source_tree:
        raise SystemExit("run summary source evidence disagrees with archive identity")
    if not (row.get("offline") or {}).get("ok"):
        raise SystemExit("one or more offline baselines failed")
    if live.get("availableRate") not in (1, 1.0):
        raise SystemExit("one or more live probes were unavailable")
    if latency.get("p95") is None or latency["p95"] > 3500:
        raise SystemExit("one or more live probes exceeded the latency gate")
    if not (row.get("product") or {}).get("e2eOk"):
        raise SystemExit("one or more product-path runs failed")
manifest = {
    "schemaVersion": 1,
    "batchId": batch_id,
    "status": "verified",
    "source": {
        "commit": source_commit,
        "tree": source_tree,
        "worktree": "clean",
    },
    "summary": {
        "runCount": run_count,
        "baselineVersion": next(iter(baselines)),
        "modelId": next(iter(model_ids)),
        "modelContentDigest": next(iter(digests)),
        "endpoint": next(iter(endpoints)),
        "runtimeId": next(iter(runtime_ids)),
        "runtimeAttestationDigest": next(iter(attestations)),
        "liveAvailableRate": 1.0,
        "maxLiveP95Ms": max(row["live"]["latencyMs"]["p95"] for row in rows),
        "offlineAllPassed": True,
        "allProductE2ePassed": True,
    },
    "runs": [
        {
            "runId": row["archive"]["runId"],
            "file": str(path),
            "sourceCommit": row["archive"]["sourceCommit"],
            "sourceTree": row["archive"]["sourceTree"],
        }
        for path, row in zip(paths, rows, strict=True)
    ],
}
manifest_path = Path(batch_manifest)
temporary = manifest_path.with_name(f".{manifest_path.name}.tmp-{os.getpid()}")
temporary.write_text(json.dumps(manifest, indent=2) + "\n")
temporary.replace(manifest_path)
print("verified calibrated archive set:", ", ".join(path.name for path in paths))
print("wrote batch manifest:", batch_manifest)
PY

echo ""
echo "=== archive complete under $ARCHIVE_DIR ==="
echo "$BATCH_MANIFEST"
while IFS= read -r META_PATH; do
  echo "$META_PATH"
done <"$BATCH_LIST"
