import { z } from 'zod'

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

const serverConfigSchema = z
  .object({
    DATABASE_URL: z.string().url().startsWith('postgresql://'),
    INDIGO_DATABASE_POOL_MAX: z.coerce.number().int().min(6).max(64).default(10),
    BETTER_AUTH_SECRET: z.string().min(32).max(512),
    BETTER_AUTH_URL: z.string().url(),
    INDIGO_CONTENT_MODE: z.enum(['development', 'reviewed']).default('reviewed'),
    NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  })
  .superRefine((input, context) => {
    const origin = new URL(input.BETTER_AUTH_URL)
    const isLoopback = loopbackHosts.has(origin.hostname)

    if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && isLoopback)) {
      context.addIssue({
        code: 'custom',
        path: ['BETTER_AUTH_URL'],
        message: 'Plain HTTP is supported only for a loopback application origin.',
      })
    }

    if (input.NODE_ENV === 'production' && input.INDIGO_CONTENT_MODE === 'development') {
      context.addIssue({
        code: 'custom',
        path: ['INDIGO_CONTENT_MODE'],
        message: 'Development coaching fixtures cannot run in production mode.',
      })
    }
  })

export type ServerConfig = {
  readonly databaseUrl: string
  readonly databasePoolMax: number
  readonly authSecret: string
  readonly appOrigin: string
  readonly contentMode: 'development' | 'reviewed'
  readonly nodeEnv: 'development' | 'test' | 'production'
  readonly secureCookies: boolean
}

export class InvalidServerConfigurationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid server configuration: ${issues.join('; ')}`)
    this.name = 'InvalidServerConfigurationError'
  }
}

export function parseServerConfig(
  input: Record<string, string | undefined>,
): ServerConfig {
  const parsed = serverConfigSchema.safeParse(input)

  if (!parsed.success) {
    throw new InvalidServerConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    )
  }

  const origin = new URL(parsed.data.BETTER_AUTH_URL)
  const nodeEnv =
    parsed.data.NODE_ENV ??
    (parsed.data.INDIGO_CONTENT_MODE === 'development' ? 'development' : 'production')

  return {
    databaseUrl: parsed.data.DATABASE_URL,
    databasePoolMax: parsed.data.INDIGO_DATABASE_POOL_MAX,
    authSecret: parsed.data.BETTER_AUTH_SECRET,
    appOrigin: origin.origin,
    contentMode: parsed.data.INDIGO_CONTENT_MODE,
    nodeEnv,
    secureCookies: origin.protocol === 'https:',
  }
}

let cachedConfig: ServerConfig | undefined

export function getServerConfig(): ServerConfig {
  cachedConfig ??= parseServerConfig(process.env)
  return cachedConfig
}

export function resetServerConfigForTests(): void {
  cachedConfig = undefined
}
