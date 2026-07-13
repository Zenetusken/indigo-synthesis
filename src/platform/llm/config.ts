import { resolve } from 'node:path'
import { z } from 'zod'

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])
export const SUPPORTED_LOCAL_LLM_ENDPOINT = 'http://127.0.0.1:8080/v1'
export const SUPPORTED_LOCAL_LLM_TIMEOUT_MS = 3_000

const llmConfigSchema = z
  .object({
    INDIGO_LLM_MODE: z.enum(['disabled', 'local']).default('disabled'),
    INDIGO_LLM_MODEL_ID: z.string().min(1).optional(),
    INDIGO_LLM_MODELS_DIR: z.string().min(1).optional(),
    INDIGO_LLM_WEIGHTS_DIR: z.string().min(1).optional(),
    INDIGO_LLM_ATTESTATION_PATH: z.string().min(1).optional(),
    INDIGO_LLM_ENDPOINT: z.string().url().optional(),
    INDIGO_LLM_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).optional(),
    INDIGO_LLM_MODEL_SHA256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    /**
     * Product policy: local inference requires a healthy NVIDIA GPU. Default true.
     * Set INDIGO_LLM_REQUIRE_GPU=false only for emergency offline diagnosis.
     */
    INDIGO_LLM_REQUIRE_GPU: z
      .enum(['true', 'false', '1', '0'])
      .optional()
      .transform((value) => {
        if (value === undefined) return true
        return value === 'true' || value === '1'
      }),
  })
  .superRefine((input, context) => {
    if (input.INDIGO_LLM_MODE === 'local' && !input.INDIGO_LLM_MODEL_ID) {
      context.addIssue({
        code: 'custom',
        path: ['INDIGO_LLM_MODEL_ID'],
        message: 'INDIGO_LLM_MODEL_ID is required when INDIGO_LLM_MODE=local',
      })
    }

    if (
      input.INDIGO_LLM_MODE === 'local' &&
      input.INDIGO_LLM_TIMEOUT_MS !== undefined &&
      input.INDIGO_LLM_TIMEOUT_MS !== SUPPORTED_LOCAL_LLM_TIMEOUT_MS
    ) {
      context.addIssue({
        code: 'custom',
        path: ['INDIGO_LLM_TIMEOUT_MS'],
        message: `supported local mode requires ${SUPPORTED_LOCAL_LLM_TIMEOUT_MS}`,
      })
    }

    if (
      input.INDIGO_LLM_MODE === 'local' &&
      input.INDIGO_LLM_ENDPOINT !== undefined &&
      input.INDIGO_LLM_ENDPOINT !== SUPPORTED_LOCAL_LLM_ENDPOINT
    ) {
      context.addIssue({
        code: 'custom',
        path: ['INDIGO_LLM_ENDPOINT'],
        message: `supported local mode requires ${SUPPORTED_LOCAL_LLM_ENDPOINT}`,
      })
    }

    if (input.INDIGO_LLM_ENDPOINT) {
      try {
        const url = new URL(input.INDIGO_LLM_ENDPOINT)
        if (!loopbackHosts.has(url.hostname)) {
          context.addIssue({
            code: 'custom',
            path: ['INDIGO_LLM_ENDPOINT'],
            message: 'INDIGO_LLM_ENDPOINT must target a loopback host',
          })
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          context.addIssue({
            code: 'custom',
            path: ['INDIGO_LLM_ENDPOINT'],
            message: 'INDIGO_LLM_ENDPOINT must use http or https',
          })
        }
      } catch {
        context.addIssue({
          code: 'custom',
          path: ['INDIGO_LLM_ENDPOINT'],
          message: 'INDIGO_LLM_ENDPOINT must be a valid URL',
        })
      }
    }
  })

export type LlmRuntimeConfig = {
  readonly mode: 'disabled' | 'local'
  readonly modelId: string | null
  readonly modelsDir: string
  readonly weightsDir: string
  readonly runtimeAttestationPath: string
  readonly endpointOverride: string | null
  readonly timeoutMsOverride: number | null
  readonly modelSha256Override: string | null
  /** When true (default), local mode is only ready if nvidia-smi reports a healthy GPU. */
  readonly requireGpu: boolean
}

export class InvalidLlmConfigurationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid LLM configuration: ${issues.join('; ')}`)
    this.name = 'InvalidLlmConfigurationError'
  }
}

export function defaultModelsDir(cwd = process.cwd()): string {
  return resolve(cwd, 'llm/models')
}

export function defaultWeightsDir(cwd = process.cwd()): string {
  return resolve(cwd, 'llm/weights')
}

export function defaultRuntimeAttestationPath(cwd = process.cwd()): string {
  return resolve(cwd, 'tmp/llm-runtime-attestation.json')
}

export function parseLlmConfig(
  input: Record<string, string | undefined>,
  cwd = process.cwd(),
): LlmRuntimeConfig {
  const requestedMode = input.INDIGO_LLM_MODE === '' ? undefined : input.INDIGO_LLM_MODE
  // Disabled mode is an isolation boundary: stale or hostile local-runtime variables
  // must not make a codes-only product path fail while no model can be called.
  const selectedInput =
    requestedMode === undefined || requestedMode === 'disabled'
      ? { INDIGO_LLM_MODE: requestedMode }
      : input
  const parsed = llmConfigSchema.safeParse(selectedInput)
  if (!parsed.success) {
    throw new InvalidLlmConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    )
  }

  const mode = parsed.data.INDIGO_LLM_MODE
  const modelsDir = resolve(
    cwd,
    parsed.data.INDIGO_LLM_MODELS_DIR ?? defaultModelsDir(cwd),
  )
  const weightsDir = resolve(
    cwd,
    parsed.data.INDIGO_LLM_WEIGHTS_DIR ?? defaultWeightsDir(cwd),
  )
  if (mode === 'local' && modelsDir !== defaultModelsDir(cwd)) {
    throw new InvalidLlmConfigurationError([
      'INDIGO_LLM_MODELS_DIR: supported local mode requires the committed llm/models registry',
    ])
  }
  if (mode === 'local' && weightsDir !== defaultWeightsDir(cwd)) {
    throw new InvalidLlmConfigurationError([
      'INDIGO_LLM_WEIGHTS_DIR: supported local mode requires the committed llm/weights artifact directory',
    ])
  }
  return {
    mode,
    modelId: parsed.data.INDIGO_LLM_MODEL_ID ?? null,
    modelsDir,
    weightsDir,
    runtimeAttestationPath: resolve(
      cwd,
      parsed.data.INDIGO_LLM_ATTESTATION_PATH ?? defaultRuntimeAttestationPath(cwd),
    ),
    endpointOverride: parsed.data.INDIGO_LLM_ENDPOINT ?? null,
    timeoutMsOverride: parsed.data.INDIGO_LLM_TIMEOUT_MS ?? null,
    modelSha256Override: parsed.data.INDIGO_LLM_MODEL_SHA256 ?? null,
    requireGpu: parsed.data.INDIGO_LLM_REQUIRE_GPU,
  }
}

let cached: LlmRuntimeConfig | undefined

export function getLlmConfig(): LlmRuntimeConfig {
  cached ??= parseLlmConfig(process.env)
  return cached
}

export function resetLlmConfigForTests(): void {
  cached = undefined
}
