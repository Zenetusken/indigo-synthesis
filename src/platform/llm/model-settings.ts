import { z } from 'zod'

const modelIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,127}$/,
    'modelId must be a lowercase identifier (letters, digits, ._-)',
  )

const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'expectedSha256 must be a lowercase hex SHA-256 digest')

export const MODEL_SETTINGS_LOOPBACK_ENDPOINT_PATTERN =
  '^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?(?:/[^\\s?#]*)?$'
export const MODEL_SETTINGS_WEIGHTS_PATH_PATTERN = '^(?!/)(?!.*\\.\\.)(?!.*\\\\).+$'

const loopbackEndpointPattern = new RegExp(MODEL_SETTINGS_LOOPBACK_ENDPOINT_PATTERN)
const weightsPathPattern = new RegExp(MODEL_SETTINGS_WEIGHTS_PATH_PATTERN)

function isLoopbackHttpEndpoint(value: string): boolean {
  return loopbackEndpointPattern.test(value)
}

export const modelSettingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    modelId: modelIdSchema,
    displayName: z.string().min(1).max(200),
    family: z.string().min(1).max(100),
    parameterCountLabel: z.string().min(1).max(32),
    format: z.string().min(1).max(32),
    quantization: z.string().min(1).max(64),
    source: z.object({
      huggingfaceRepo: z.string().min(1),
      huggingfaceFileGlob: z.string().min(1),
      baseModel: z.string().min(1),
      notes: z.string(),
    }),
    artifacts: z.object({
      weightsRelativePath: z
        .string()
        .min(1)
        .refine(
          (path) => weightsPathPattern.test(path),
          'weightsRelativePath must be a relative path without traversal',
        ),
      expectedSha256: sha256Schema,
      approxSizeBytes: z.number().int().positive(),
    }),
    runtime: z.object({
      adapter: z.enum(['openai-compatible-loopback', 'disabled']),
      defaultEndpoint: z
        .string()
        .url()
        .refine(
          isLoopbackHttpEndpoint,
          'defaultEndpoint must use HTTP(S) on a loopback host',
        ),
      servedModelName: z.string().min(1),
      recommendedServer: z.string().min(1),
      minLlamaCppNote: z.string(),
    }),
    chat: z.object({
      enableThinking: z.boolean(),
      systemPromptProfile: z.literal('grounded-explanation'),
    }),
    sampling: z.object({
      temperature: z.number().min(0).max(2),
      topP: z.number().min(0).max(1),
      topK: z.number().int().min(0),
      minP: z.number().min(0).max(1),
      presencePenalty: z.number().min(-2).max(2),
      repetitionPenalty: z.number().min(0).max(2),
      maxTokens: z.number().int().min(1).max(256),
    }),
    limits: z.object({
      timeoutMs: z.number().int().min(100).max(120_000),
      maxContextTokens: z.number().int().min(256),
    }),
    capabilities: z.object({
      tasks: z.array(z.literal('grounded-explanation')).min(1),
      multimodal: z.boolean(),
    }),
  })
  .strict()

export type ModelSettings = z.infer<typeof modelSettingsSchema>

export class InvalidModelSettingsError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid model settings: ${issues.join('; ')}`)
    this.name = 'InvalidModelSettingsError'
  }
}

export function parseModelSettings(input: unknown): ModelSettings {
  const parsed = modelSettingsSchema.safeParse(input)
  if (!parsed.success) {
    throw new InvalidModelSettingsError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`,
      ),
    )
  }
  return parsed.data
}
