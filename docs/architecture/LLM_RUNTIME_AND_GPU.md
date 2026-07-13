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

## Operator sequence

```sh
# 1) Host health
pnpm llm:preflight

# 2) If GPU = mismatch → reboot, then preflight again

# 3) Weights for the Indigo pack
pnpm llm:download-qwen35

# 4) Server + model
pnpm llm:serve
pnpm llm:load            # or lms load <key> -y

# 5) Contract + optional live metrics
pnpm llm:validate-baseline
INDIGO_LLM_LIVE=1 \
INDIGO_LLM_ENDPOINT=http://127.0.0.1:1234/v1 \
INDIGO_LLM_MODEL_ID=qwen3.5-9b-q4_k_m \
pnpm llm:validate-baseline --json
```

## Coherence checklist

| Piece | Healthy signal |
| --- | --- |
| RAM | `sufficientForApproxModelBytes=true` |
| GPU | `gpu.state=ready` (or CPU path accepted knowingly) |
| Weights | file under `llm/weights/` or model listed in LM Studio |
| Server | `endpoint.reachable=true` on loopback |
| Pack | `servedModelName` matches a `/v1/models` id (or override endpoint model) |
| Offline baseline | `pnpm llm:validate-baseline` PASS |
| Live | `availableRate` recorded with model digest |

Until the offline baseline is green and live runs are archived per the measurement
protocol, do not enable trainee-facing prose UI.
