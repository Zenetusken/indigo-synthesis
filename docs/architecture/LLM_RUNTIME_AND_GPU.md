# LLM runtime and GPU coherence

Status: operator runbook
Related: [LLM measurement protocol](LLM_MEASUREMENT_PROTOCOL.md),
[model/runtime locks](../../llm/README.md)

## Product policy

The local language layer is optional, loopback-only, and GPU-only. Core product paths
remain available with `INDIGO_LLM_MODE=disabled`.

| Control | Supported value | Meaning |
| --- | --- | --- |
| `INDIGO_LLM_REQUIRE_GPU` | `true` | Product readiness requires healthy NVIDIA state |
| `INDIGO_LLM_N_GPU_LAYERS` | `all` | llama.cpp offloads every model layer; `-1` means auto and is not accepted |
| endpoint | `http://127.0.0.1:8080/v1` | Exact IPv4 loopback binding |
| model | `qwen3.5-9b-q4_k_m` | Only the digest-locked pack is supported |
| model settings | committed `llm/models` registry | Sampling, limits, and prompt metadata are reviewed code |
| weights path | committed `llm/weights` directory | Download, preflight, and launcher resolve the same artifact |
| context | `4096` tokens | Launcher argv and preflight must match the committed pack limit |
| timeout | `3000` ms | Interactive explanation budget |

CPU, partial/auto offload, LM Studio, alternate packs, redirecting endpoints, and
unattested servers can be used for private diagnosis only; none may report product
readiness.

## RAM and NVIDIA gates

A 5.68 GB Q4_K_M file needs roughly the model size plus 4 GiB of available system RAM
before loading. Once the exact process is attested and resident, requiring room for a
second copy is a false blocker; steady-state readiness instead preserves 4 GiB of
remaining operating headroom. Preflight reports its `model-load` or `verified-runtime`
memory basis explicitly.

| MemAvailable | Verdict |
| --- | --- |
| at least 12 GiB | comfortable |
| 8–12 GiB | close heavy processes first |
| below 8 GiB | do not load the 9B runtime |

For an already verified runtime, `MemAvailable` below 4 GiB blocks inference; 4 GiB or
more is sufficient even when full reload headroom is temporarily unavailable. Stop the
runtime before using the pre-load table to decide whether it can be loaded again.

`pnpm llm:preflight` reads `/proc/meminfo` and runs `nvidia-smi`. If NVML reports a
driver/library mismatch after a package update, save work and reboot; do not unload
NVIDIA modules from an active graphical session. After reboot, confirm `nvidia-smi`
and `/sys/module/nvidia/version` agree.

## Provenance chain

The supported stack is pinned at every mutable project-controlled layer:

```text
artifact.lock.json ─► exact HF revision / filename / size / weights SHA-256
settings.json      ─► committed sampling / limits / prompt metadata
llama-cpp.lock.json ─► source commit / CUDA architecture
                    ├► launcher SHA-256 + size
                    └► every local llama / ggml / mtmd DSO SHA-256 + size
serve-local.sh      ─► exact loopback / model / alias / context / all-layer argv
attestation.json    ─► PID + process start + file identities + all digests
preflight           ─► /proc exe, argv, exact maps, listener + /props + /models + NVIDIA PID memory
```

The launcher writes `tmp/llm-runtime-attestation.json` atomically with mode `0600`
before replacing its shell PID with `llama-server`. Preflight rejects stale PIDs,
changed files, unmapped/substituted/extra runtime DSOs, wrong host/port/context or listener PID,
wrong build/model props, a wrong served name, missing GPU allocation, or a configured
digest that differs from the pack. The supported launcher clears dynamic-loader override
variables before attestation and execution.

The binary/DSO digest set is deliberately host-build-specific. Changing the source
checkout path or toolchain can change RPATH/build output and requires an explicit
review/re-pin. The local attestation protects against accidental/stale substitution;
same-user malicious tampering is outside its threat model.

## Clean operator sequence

```sh
cd ~/project/indigo-synthesis

# Artifact and exact host build
pnpm llm:download-qwen35
pnpm llm:build-cuda

# Starts the pinned server and creates a fresh attestation
pnpm llm:serve
```

In a second shell:

```sh
# Archive evidence must identify committed reviewed source.
git status --short --untracked-files=all  # must print nothing

export INDIGO_LLM_MODE=local
export INDIGO_LLM_MODEL_ID=qwen3.5-9b-q4_k_m
export INDIGO_LLM_MODEL_SHA256=03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8
export INDIGO_LLM_N_GPU_LAYERS=all
export INDIGO_LLM_TIMEOUT_MS=3000

pnpm llm:preflight
pnpm llm:validate-baseline
pnpm test:e2e:llm
RUNS=3 pnpm llm:archive-product-path
```

Supported local application config rejects alternate model-settings/weights directories
and deadlines other than 3,000 ms. The live browser and multi-run archive commands also
pin those values rather than inheriting a caller's diagnostic environment.

The calibrated archive refuses staged, unstaged, or untracked source changes and
rechecks the full HEAD commit plus root-tree object around every run. Each verified
per-run JSON records both object IDs. A successful batch additionally writes an
`archive-batch-*.json` manifest/summary that proves every run shares the same source,
model, runtime attestation, and baseline identities. Raw logs or support files left by
an aborted batch are diagnostic only; without the verified batch manifest they are not
calibration evidence.

For a one-shot post-reboot bootstrap, `pnpm llm:measure-gpu` checks raw GPU/artifact
state first, builds if the binary lock is absent, stops only the twice-verified attested
listener through an exact Linux pidfd, rechecks full model-load RAM after that process
exits, starts the pinned server, and only then runs full preflight and live measurement.
The per-UID lifecycle lock covers the whole replacement/measurement transition. Logs and
measurement JSON use mode-0600 temporary files in the owned lock directory. The command
does not run readiness preflight before the server exists and does not broadly `pkill`
unrelated processes.

## Healthy signals

| Layer | Required evidence |
| --- | --- |
| RAM | `sufficientForReadiness=true` under the reported memory basis |
| GPU | `gpu.state=ready` and attested PID has non-zero NVIDIA allocation |
| weights | exact size/digest in the artifact lock |
| runtime | `runtimeEvidence.state=verified` |
| endpoint | exact model alias from non-redirecting `/v1/models` |
| composition | verified runtime identity matches the committed pack |
| source | clean worktree; one full Git commit/root-tree identity across the batch |
| offline | every baseline check passes at the current FactBundle-v2/prompt-v3 contract |
| live | every eligible case available within the configured timeout |
| browser | opt-in live E2E passes with deterministic codes still visible |

Default `pnpm test:e2e` forces disabled mode, regardless of parent-shell LLM variables.
Only `pnpm test:e2e:llm` enables the verified local runtime.
