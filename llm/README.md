# Local language model runtime

The optional LLM produces grounded explanation prose only. Deterministic training
decisions, pain holds, rule codes, and core journeys never depend on inference. The
default product mode is `disabled`.

See [ADR 0006](../docs/architecture/adr/0006-optional-local-grounded-language.md), the
[explanation contract](../docs/architecture/EXPLANATION_GENERATION_CONTRACT.md), and the
[runtime runbook](../docs/architecture/LLM_RUNTIME_AND_GPU.md).

## Committed identity

The supported runtime is intentionally narrow:

- model pack: `qwen3.5-9b-q4_k_m`;
- source artifact: `unsloth/Qwen3.5-9B-GGUF` at revision
  `3885219b6810b007914f3a7950a8d1b469d598a5`;
- exact file: `Qwen3.5-9B-Q4_K_M.gguf`, 5,680,522,464 bytes;
- SHA-256: `03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8`;
- server: the CUDA llama.cpp commit and host-built binary/DSO closure pinned in
  `runtime/llama-cpp.lock.json`.

`models/qwen3.5-9b-q4_k_m/artifact.lock.json` is the download authority. Product packs
must have a committed, non-null digest. `INDIGO_LLM_MODEL_SHA256` is an assertion and
may only equal that digest; it cannot override it. The former unverified Q5 pack is not
a supported product path.

## Layout

```text
llm/
  models/qwen3.5-9b-q4_k_m/
    artifact.lock.json              # exact upstream revision/file/digest/size
    settings.json                   # prompt/runtime/sampling contract
  runtime/llama-cpp.lock.json       # exact source, launcher, and local DSO closure
  schema/model-settings.schema.json
  weights/                          # operator-installed artifacts; gitignored
tmp/llm-runtime-attestation.json    # live launcher evidence; gitignored, mode 0600
```

The binary lock is host-specific by design: it records the supported Ada/CUDA `sm_89`
build at the configured build path. A different GPU architecture, source path, or
toolchain must be reviewed, rebuilt, and re-pinned rather than silently treated as
equivalent.

## Operator sequence

Host prerequisites include Node/pnpm, Python >=3.10, the current Hugging Face `hf` CLI, CUDA
build tools, `nvidia-smi`, `curl`, `lsof` (used to prove listener ownership safely), and
`flock` (used to serialize runtime transitions, destructive E2E, and calibrated archive
work). Linux `pidfd_open`/`pidfd_send_signal` support is required for attested runtime
replacement.

```sh
pnpm llm:download-qwen35   # exact revision/file; verify digest and size before install
pnpm llm:build-cuda        # clean detached pinned commit; verify binary + DSO closure
pnpm llm:serve             # 127.0.0.1:8080; literal all-layer CUDA offload; attest

INDIGO_LLM_MODE=local \
INDIGO_LLM_MODEL_ID=qwen3.5-9b-q4_k_m \
pnpm llm:preflight         # must report runtime: verified and ready=true

pnpm llm:validate-baseline # required offline contract gate
pnpm test:e2e:llm          # opt-in live browser path

# Commit the reviewed source first; this must print nothing.
git status --short --untracked-files=all
RUNS=3 pnpm llm:archive-product-path
```

The download command requires the current Hugging Face `hf` CLI. It never uses a glob
or selects the first matching file. Existing weights are re-verified before reuse.

`pnpm llm:serve` refuses non-loopback binding, alternate aliases/packs/context length,
CPU or partial offload, a mismatched executable, mutable llama/ggml libraries, or an
uncommitted model digest. It hashes the weights, launcher, and complete project-local
DSO closure before atomically writing the runtime attestation, then `exec`s the server
without changing the attested PID/start identity. A per-UID lifecycle lock prevents
overlapping supported starts until the new process passes full readiness handoff; a live
but unverified process retains that lock. The final pre-exec gate requires the exact
artifact size plus 4 GiB in `MemAvailable`.

Preflight additionally verifies:

- full model-load headroom before startup, or 4 GiB operating headroom after the exact
  runtime is already attested and resident;
- NVIDIA health and a live allocation for the attested PID;
- exact process start identity, executable, context/model arguments, and mapped
  llama/ggml DSOs;
- exact host/port arguments plus ownership of the configured listening socket;
- unchanged file device/inode/size/mtime identities;
- `/props` build, model alias, and real model path;
- exact `/v1/models` served name with redirects forbidden.

This local evidence prevents accidental or stale runtime substitution. A malicious
process with the same OS user is outside its stated threat model.

## Application environment

```dotenv
INDIGO_LLM_MODE=disabled
# INDIGO_LLM_MODE=local
# INDIGO_LLM_MODEL_ID=qwen3.5-9b-q4_k_m
# INDIGO_LLM_ENDPOINT=http://127.0.0.1:8080/v1
# INDIGO_LLM_TIMEOUT_MS=3000
# INDIGO_LLM_MODEL_SHA256=03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8
# INDIGO_LLM_ATTESTATION_PATH=tmp/llm-runtime-attestation.json
# INDIGO_LLM_N_GPU_LAYERS=all
```

Supported local application mode resolves model settings and weights only from the
committed `llm/models` and `llm/weights` directories and requires the exact 3,000 ms
deadline. Alternate directories or longer deadlines are diagnostic experiments, not
product configuration; the live Playwright and archive commands overwrite inherited
values with the committed contract.

An unset or exactly empty `INDIGO_LLM_MODE` normalizes to `disabled`. Whitespace-only or
unknown values remain invalid instead of being guessed.

Only the opt-in live Playwright configuration enables local mode. Default E2E forces
`INDIGO_LLM_MODE=disabled` even if the parent shell contains adversarial LLM variables.

## Contract gates

`pnpm llm:validate-baseline` runs without weights or a server. It checks FactBundle v2,
closed-output prompt v3, validator v4, the committed pack registry, non-empty accepted
and rejection matrices, adversarial numeric and advice cases, invalidation, fake
synthesis, and disabled composition.

The merged-tree checkpoint uses baseline `2026-07-13.5`: 43/43 offline checks across nine
goldens and 21 rejection traps. Its final clean-tree three-run archive recorded live
availableRate 1.0 in every run, p50 `806 / 807 / 807` ms, p95
`1177 / 1017 / 1012` ms, and green live History E2E. The archived root tree is byte-equal
to `99ace8c^{tree}`. This archive is operator-local evidence under the gitignored
`tmp/llm-runs/` directory, not a versioned repository artifact; later calibration claims
require a newly verified batch.

The live probe is useful only after full preflight succeeds. A calibrated product-path
archive requires a clean staged/unstaged/untracked worktree and at least three runs with
one full Git commit/root-tree identity, one model digest, one runtime-attestation digest,
a 1.0 live available rate, p95 within the interactive budget tolerance, and a green
browser journey on every run. Verified per-run JSON records the source identity and a
successful batch publishes an `archive-batch-*.json` manifest/summary. The archive
command fails instead of warning when those conditions are not met; raw files from an
aborted batch are not calibration evidence.

## Adding another model or runtime

Adding a product pack is a reviewed code/provenance change, not an environment-only hot
swap. Add an exact artifact lock and non-null pack digest, extend the supported launcher
and attestation verifier, add grounded baselines, then re-run default and live gates.

CI never downloads weights or starts inference.
