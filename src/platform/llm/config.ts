import { resolve } from 'node:path'
import { z } from 'zod'

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

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
  const parsed = llmConfigSchema.safeParse(input)
  if (!parsed.success) {
    throw new InvalidLlmConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    )
  }

  const mode = parsed.data.INDIGO_LLM_MODE
  return {
    mode,
    modelId: parsed.data.INDIGO_LLM_MODEL_ID ?? null,
    modelsDir: resolve(cwd, parsed.data.INDIGO_LLM_MODELS_DIR ?? defaultModelsDir(cwd)),
    weightsDir: resolve(
      cwd,
      parsed.data.INDIGO_LLM_WEIGHTS_DIR ?? defaultWeightsDir(cwd),
    ),
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
