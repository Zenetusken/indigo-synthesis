# Local language model packs

Optional host-local inference for **grounded explanation prose** only. Core product
journeys never require a model. See
[ADR 0006](../docs/architecture/adr/0006-optional-local-grounded-language.md) and the
[explanation generation contract](../docs/architecture/EXPLANATION_GENERATION_CONTRACT.md).

## Layout

```text
llm/
  models/<modelId>/settings.json   # pack config (in git)
  weights/                         # operator-installed artifacts (gitignored)
  schema/model-settings.schema.json
```

Hot-swap: install another pack under `models/`, place matching weights, set
`INDIGO_LLM_MODEL_ID` to that pack’s `modelId`. Application code does not hard-code a
vendor model.

## First packs

| modelId | Quant | Source |
| --- | --- | --- |
| `qwen3.5-9b-q4_k_m` (recommended default) | Q4_K_M | [unsloth/Qwen3.5-9B-GGUF](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF) |
| `qwen3.5-9b-q5_k_m` | Q5_K_M | same repo |

Approximate sizes: Q4_K_M ~5.7 GB file / ~6.5 GB RAM+VRAM; Q5_K_M ~6.6 GB file.

## Install weights (operator)

1. Use a **recent** llama.cpp build with `qwen35` support.
2. Download a quant (example Q4_K_M):

```sh
# requires: huggingface-cli or hf
hf download unsloth/Qwen3.5-9B-GGUF \
  --local-dir /tmp/qwen3.5-9b-gguf \
  --include '*Q4_K_M*.gguf'
```

3. Copy the file into `llm/weights/` using the path in `settings.json`
   (`artifacts.weightsRelativePath`), e.g.:

```sh
cp /tmp/qwen3.5-9b-gguf/*Q4_K_M*.gguf llm/weights/qwen3.5-9b-q4_k_m.gguf
```

4. Record the digest (recommended):

```sh
sha256sum llm/weights/qwen3.5-9b-q4_k_m.gguf
# set INDIGO_LLM_MODEL_SHA256=... or fill artifacts.expectedSha256 in a local override
```

5. Serve on **loopback only** (example):

```sh
llama-server \
  --model llm/weights/qwen3.5-9b-q4_k_m.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  --alias qwen3.5-9b-q4_k_m \
  --temp 0.3 \
  --top-p 0.8 \
  --top-k 20 \
  --min-p 0.00 \
  -c 4096 \
  --chat-template-kwargs '{"enable_thinking":false}'
```

Pack sampling is applied again by the app client; server defaults should still prefer
non-thinking mode for Qwen3.5 Small.

## Application env

```dotenv
INDIGO_LLM_MODE=disabled
# INDIGO_LLM_MODE=local
# INDIGO_LLM_MODEL_ID=qwen3.5-9b-q4_k_m
# INDIGO_LLM_MODELS_DIR=llm/models
# INDIGO_LLM_WEIGHTS_DIR=llm/weights
# INDIGO_LLM_ENDPOINT=http://127.0.0.1:8080/v1
# INDIGO_LLM_TIMEOUT_MS=3000
# INDIGO_LLM_MODEL_SHA256=
```

Default is **disabled**. With `local`, the app loads the pack by id and calls the
OpenAI-compatible endpoint on loopback only.

## Hot-swap to Q5

1. Download Q5_K_M into `llm/weights/qwen3.5-9b-q5_k_m.gguf`.
2. Restart llama-server with that file and `--alias qwen3.5-9b-q5_k_m`.
3. Set `INDIGO_LLM_MODEL_ID=qwen3.5-9b-q5_k_m`.
4. No TypeScript change required.

## Adding a new model

1. Create `llm/models/<modelId>/settings.json` matching the schema.
2. Place weights under `llm/weights/` (or absolute path via env later).
3. Use an existing `runtime.adapter` or implement a new adapter under
   `src/platform/llm/adapters/`.
4. Point `INDIGO_LLM_MODEL_ID` at the new id.

## Product rules

- Models only generate **inferred** explanation prose over a FactBundle.
- Deterministic methodology never calls the LLM.
- Validation rejects prose that invents loads or omits reason codes.
- CI does not download weights or start inference.

## Calibrated baseline

Offline contract baseline (no weights, no server) is the CI-grade calibration gate:

```sh
pnpm llm:validate-baseline
```

It loads both model packs, runs the golden FactBundle suite (increase / holds / pain
block / invalidated), checks accepted templates pass and trap prose fails, and verifies
fake synthesize + disabled defaults. Baseline version: see
`LLM_BASELINE_VERSION` in `src/platform/llm/baseline/golden-cases.ts`.

Optional live probe against a running loopback server (informational; unreachable does
not fail the offline gate):

```sh
INDIGO_LLM_LIVE=1 \
INDIGO_LLM_ENDPOINT=http://127.0.0.1:8080/v1 \
INDIGO_LLM_MODEL_ID=qwen3.5-9b-q4_k_m \
pnpm llm:validate-baseline
```

Live results only count as calibrated when cases return `available` after the validation
gate. Treat that as operator evidence, not a product claim that the model is coaching.
