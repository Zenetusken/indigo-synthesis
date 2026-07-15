import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { betterAuth } from 'better-auth/minimal'
import { nextCookies } from 'better-auth/next-js'
import { getDb } from '@/platform/db/client'
import { resetCredentialLoadShedderForTests } from './credential-load-shedder'
import {
  createIdentityAuthOptions,
  identityAuthDatabaseSchema,
} from './identity-auth-config'
import { identitySessionCookiePlugin } from './session-cookie-endpoints'

function createAuth() {
  return betterAuth({
    ...createIdentityAuthOptions('read-only'),
    database: drizzleAdapter(getDb(), {
      provider: 'pg',
      schema: identityAuthDatabaseSchema,
      transaction: true,
    }),
    plugins: [identitySessionCookiePlugin(), nextCookies()],
  })
}

type ReadOnlyIdentityAuth = ReturnType<typeof createAuth>

let authInstance: ReadOnlyIdentityAuth | undefined

function getReadOnlyAuth(): ReadOnlyIdentityAuth {
  authInstance ??= createAuth()
  return authInstance
}

export function readIdentitySession(headers: Headers) {
  return getReadOnlyAuth().api.getSession({
    headers,
    query: { disableCookieCache: true, disableRefresh: true },
  })
}

export function handleIdentityGetSession(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname
  if (request.method !== 'GET' || pathname !== '/api/auth/get-session') {
    throw new TypeError('Read-only Identity auth received an unsupported route.')
  }
  return getReadOnlyAuth().handler(request)
}

export type IdentitySessionCookieVerification =
  | { readonly kind: 'verified'; readonly sessionToken: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'rejected'; readonly response: Response }

export async function verifyIdentitySessionCookie(
  request: Request,
): Promise<IdentitySessionCookieVerification> {
  const response = await getReadOnlyAuth().api.verifyIdentitySessionCookie({
    request,
    headers: request.headers,
    asResponse: true,
  })
  if (!response.ok) return { kind: 'rejected', response }
  const result = (await response.json()) as { readonly sessionToken?: unknown }
  return typeof result.sessionToken === 'string'
    ? { kind: 'verified', sessionToken: result.sessionToken }
    : { kind: 'absent' }
}

export function clearProvenAbsentIdentitySession(request: Request): Promise<Response> {
  return getReadOnlyAuth().api.clearProvenAbsentIdentitySession({
    request,
    headers: request.headers,
    asResponse: true,
  })
}

export function resetAuthForTests(): void {
  authInstance = undefined
  resetCredentialLoadShedderForTests()
}
