# LLM runtime and GPU coherence

Status: operator runbook  
Related: [LLM measurement protocol](LLM_MEASUREMENT_PROTOCOL.md), [llm/README.md](../../llm/README.md)

## RAM gate

A 9B Q4_K_M GGUF is ~5.7–6.5 GB on disk and needs roughly **model size + ≥4 GiB** free
`MemAvailable` for comfortable load (KV cache, OS, Next.js).

| MemAvailable | Verdict |
| --- | --- |
| ≥ 12 GiB | Comfortable for Q4 + headroom |
| 8–12 GiB | Possible; close heavy browsers first |
| < 8 GiB | Do not load 9B; free memory first |

Check: `pnpm llm:preflight` (reads `/proc/meminfo`).

## Product policy: GPU only

The Indigo LLM layer **must not** run product inference on CPU.

| Control | Default | Effect |
| --- | --- | --- |
| `INDIGO_LLM_REQUIRE_GPU` | `true` | Preflight is not ready unless `nvidia-smi` is healthy |
| `INDIGO_LLM_N_GPU_LAYERS` | `-1` | Serve refuses to start with `0` when GPU is required |
| `pnpm llm:serve` | GPU assert | Exits 2 if NVML/driver mismatch or no GPU |

Emergency diagnosis only: `INDIGO_LLM_REQUIRE_GPU=false` (never a release path).

## GPU coherence (NVIDIA on Pop!_OS)

### Healthy state

- `nvidia-smi` prints GPU name, driver version, memory
- Loaded kernel module version **equals** userspace (`nvidia-utils` / NVML)
- DKMS shows the same version for the running kernel

### Current failure mode: driver/library mismatch

Symptoms:

```text
Failed to initialize NVML: Driver/library version mismatch
```

Typical cause after a driver package upgrade **without reboot**:

| Layer | Example |
| --- | --- |
| Still **loaded** kernel module | `580.159.03` (`/sys/module/nvidia/version`) |
| Installed userspace / DKMS | `580.173.02` |
| Result | NVML and CUDA apps fail; display may still “work” on the old module |

**Fix (required for CUDA):**

1. Save work.
2. **Reboot** (cleanest). This loads the installed DKMS module.
3. Verify: `nvidia-smi` and `cat /sys/module/nvidia/version` match package version.
4. Re-run `pnpm llm:preflight` — GPU state should be `ready`.

Avoid unloading `nvidia` modules while an active graphical session uses the GPU; that
can freeze the display. Prefer reboot over `rmmod` on a workstation session.

### After GPU is healthy

Prefer CUDA offload when starting `llama-server` (`--n-gpu-layers -1`).  
`pnpm llm:serve` uses LM Studio when `lms` is present; LM Studio CUDA backends live under
`~/.lmstudio/extensions/backends/llama.cpp-*-nvidia-cuda*`.

If GPU remains broken, CPU inference is still valid for calibration but slower — set
expectations in the live probe metrics, do not loosen the validation gate.

## Loopback topology (product-aligned)

```text
Next.js / scripts  ──loopback only──►  OpenAI-compatible server
                                       llama-server :8080  (preferred; qwen35)
                                       LM Studio :1234     (fallback; may lack qwen35)
                                              │
                                              ▼
                                       GGUF weights (+ CUDA if healthy)
```

Recommended server binary: build recent `llama.cpp` (this host uses
`~/project/llama.cpp-indigo/build/bin/llama-server`). LM Studio 1.26 backends rejected
architecture `qwen35` as of this writing.

- Core product still defaults `INDIGO_LLM_MODE=disabled`.
- No cloud model dependency.
- Architecture tests allow fetch only in the loopback LLM adapter + preflight.

## Operator sequence (GPU-only)

```sh
# If preflight shows driver mismatch:
pnpm llm:reboot-cuda    # or: sudo reboot

# After reboot — one-shot GPU measure:
cd ~/project/indigo-synthesis
git checkout feat/llm-modular-inference-layer
pnpm llm:measure-gpu
# builds CUDA llama-server if needed, serves ngl=-1, live baseline JSON

# Manual steps:
pnpm llm:preflight      # requireGpu=true; gpu.state must be ready
pnpm llm:build-cuda
pnpm llm:serve          # fails closed without healthy nvidia-smi
INDIGO_LLM_LIVE=1 pnpm llm:validate-baseline --json

# Browser product path (History Explain with MODE=local + GPU):
pnpm test:e2e:llm
```

`pnpm test:e2e` keeps `INDIGO_LLM_MODE=disabled` and never requires a GPU.  
`pnpm test:e2e:llm` is operator-only: it starts the Next e2e supervisor with
`INDIGO_LLM_MODE=local`, `INDIGO_LLM_REQUIRE_GPU=true`, and the loopback endpoint,
then asserts grounded History prose (or honest soft failure) after a completed workout.

## Coherence checklist

| Piece | Healthy signal |
| --- | --- |
| RAM | `sufficientForApproxModelBytes=true` |
| GPU | `gpu.state=ready` (**required** for product local mode) |
| Weights | file under `llm/weights/` |
| Server | `endpoint.reachable=true` on loopback **with CUDA offload** |
| Pack | `servedModelName` matches a `/v1/models` id |
| Offline baseline | `pnpm llm:validate-baseline` PASS |
| Live GPU measure | `availableRate=1.0` + `nvidia-smi` shows model VRAM |

Until offline baseline is green **and** a GPU live measure is archived, do not enable
trainee-facing prose UI.
