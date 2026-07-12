import { resolve } from 'node:path'
import { z } from 'zod'

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

const llmConfigSchema = z
  .object({
    INDIGO_LLM_MODE: z.enum(['disabled', 'local']).default('disabled'),
    INDIGO_LLM_MODEL_ID: z.string().min(1).optional(),
    INDIGO_LLM_MODELS_DIR: z.string().min(1).optional(),
    INDIGO_LLM_WEIGHTS_DIR: z.string().min(1).optional(),
    INDIGO_LLM_ENDPOINT: z.string().url().optional(),
    INDIGO_LLM_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).optional(),
    INDIGO_LLM_MODEL_SHA256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
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
  readonly endpointOverride: string | null
  readonly timeoutMsOverride: number | null
  readonly modelSha256Override: string | null
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
    endpointOverride: parsed.data.INDIGO_LLM_ENDPOINT ?? null,
    timeoutMsOverride: parsed.data.INDIGO_LLM_TIMEOUT_MS ?? null,
    modelSha256Override: parsed.data.INDIGO_LLM_MODEL_SHA256 ?? null,
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
