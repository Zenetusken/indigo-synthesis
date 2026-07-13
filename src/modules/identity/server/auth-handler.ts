import { createHmac } from 'node:crypto'
import { toNextJsHandler } from 'better-auth/next-js'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getServerConfig } from '@/platform/config/server'
import { getDb } from '@/platform/db/client'
import { user } from '@/platform/db/schema'
import { getAuth } from '../infrastructure/auth'
import { resolveWebClientAddress } from '../infrastructure/client-address'
import {
  CredentialLifecycleCapacityError,
  CredentialLifecycleUnavailableError,
  withSubmittedEmailCredentialLifecycleLocks,
} from '../infrastructure/credential-lifecycle-lock'
import {
  admitWebRecoveryAttempt,
  isWebRecoveryAttemptThrottled,
} from '../infrastructure/web-recovery-rate-limit'
import { normalizeRecoveryEmail } from '../recovery/recovery-policy'

type AuthHandler = (request: Request) => Promise<Response>

const allowedExternalIdentityRequests = new Set([
  'GET /get-session',
  'POST /sign-in/email',
  'POST /sign-out',
])
const invalidProviderEmail = `${'i'.repeat(64)}@${'d'.repeat(63)}.${'u'.repeat(63)}.${'m'.repeat(63)}.com`

function authHandlers() {
  return toNextJsHandler(getAuth())
}

function authPath(request: Request): string {
  const pathname = new URL(request.url).pathname.replace(/\/+$/, '')
  const authRoot = '/api/auth'
  const rootIndex = pathname.lastIndexOf(authRoot)
  return rootIndex >= 0 ? pathname.slice(rootIndex + authRoot.length) || '/' : pathname
}

function unsupportedIdentityRequest(request: Request): boolean {
  return !allowedExternalIdentityRequests.has(`${request.method} ${authPath(request)}`)
}

function unsupportedIdentityMutationResponse(): Response {
  return Response.json({ code: 'NOT_FOUND', message: 'Not found.' }, { status: 404 })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonResponseWithProviderHeaders(response: Response, body: unknown): Response {
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.set('content-type', 'application/json')
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** Keep opaque cookie credentials HttpOnly even though Better Auth returns them by default. */
async function redactBrowserSessionToken(
  request: Request,
  response: Response,
): Promise<Response> {
  if (!response.ok) return response
  const path = authPath(request)
  if (path !== '/sign-in/email' && path !== '/get-session') return response

  const body: unknown = await response.json()
  if (!isRecord(body)) return jsonResponseWithProviderHeaders(response, body)

  if (path === '/sign-in/email') {
    const { token: _token, ...safeBody } = body
    return jsonResponseWithProviderHeaders(response, safeBody)
  }

  const sessionValue = body.session
  if (!isRecord(sessionValue)) return jsonResponseWithProviderHeaders(response, body)
  const { token: _token, ...safeSession } = sessionValue
  return jsonResponseWithProviderHeaders(response, { ...body, session: safeSession })
}

function isEmailSignIn(request: Request): boolean {
  return (
    request.method === 'POST' &&
    new URL(request.url).pathname.replace(/\/+$/, '').endsWith('/sign-in/email')
  )
}

type SignInCredentialRequest = {
  readonly email: string
  readonly providerRequest: Request
  readonly valid: boolean
}

function dummyProviderPassword(): string {
  return createHmac('sha256', getServerConfig().authSecret)
    .update('sign-in-dummy-password-v1\0', 'utf8')
    .digest('base64url')
}

async function signInCredentialRequest(
  request: Request,
): Promise<SignInCredentialRequest> {
  let rawEmail: unknown
  let rawPassword: unknown
  let rawRememberMe: unknown
  try {
    if (
      request.headers.get('content-type')?.includes('application/x-www-form-urlencoded')
    ) {
      const body = await request.clone().formData()
      rawEmail = body.get('email')
      rawPassword = body.get('password')
      rawRememberMe = body.get('rememberMe')
    } else {
      const body: unknown = await request.clone().json()
      if (isRecord(body)) {
        rawEmail = body.email
        rawPassword = body.password
        rawRememberMe = body.rememberMe
      }
    }
  } catch {
    // Continue through the bounded dummy provider path.
  }

  const email = normalizeRecoveryEmail(
    typeof rawEmail === 'string' ? rawEmail : 'invalid-email',
  )
  const validEmail = z.email().safeParse(email).success
  const validPassword =
    typeof rawPassword === 'string' &&
    rawPassword.length <= 128 &&
    !rawPassword.includes('\0')
  const valid = validEmail && validPassword
  const headers = new Headers(request.headers)
  headers.delete('content-length')
  headers.set('content-type', 'application/json')
  const rememberMe = rawRememberMe !== false && rawRememberMe !== 'false'

  return {
    email,
    valid,
    providerRequest: new Request(request.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email: valid ? email : invalidProviderEmail,
        password: valid ? rawPassword : dummyProviderPassword(),
        rememberMe,
      }),
      signal: request.signal,
    }),
  }
}

async function userIdForEmail(email: string): Promise<string | null> {
  const [record] = await getDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(sql`lower(${user.email})`, email))
    .limit(1)
  return record?.id ?? null
}

function forwardingFailure(): Response {
  return Response.json(
    {
      code: 'AUTH_CLIENT_ADDRESS_UNAVAILABLE',
      message: 'Authentication request denied.',
    },
    { status: 400 },
  )
}

function signInFailure(): Response {
  return Response.json(
    {
      kind: 'rejected',
      message: 'The email or password was not accepted.',
    },
    { status: 401 },
  )
}

export async function handleAuthRequest(
  request: Request,
  handler: AuthHandler,
): Promise<Response> {
  if (unsupportedIdentityRequest(request)) {
    return unsupportedIdentityMutationResponse()
  }

  const config = getServerConfig()
  const clientAddress = resolveWebClientAddress(request.headers, {
    allowDirectLoopback: !config.secureCookies,
  })
  if (!clientAddress) {
    return forwardingFailure()
  }

  if (!isEmailSignIn(request)) {
    return redactBrowserSessionToken(request, await handler(request))
  }

  const signIn = await signInCredentialRequest(request)
  const email = signIn.email
  const rateInput = {
    purpose: 'sign-in' as const,
    email,
    clientAddress,
  }
  if (await isWebRecoveryAttemptThrottled(rateInput)) return signInFailure()

  try {
    return await withSubmittedEmailCredentialLifecycleLocks({
      email,
      resolveAccountUserIds: async () => {
        const userId = await userIdForEmail(email)
        return userId ? [userId] : []
      },
      callback: async () => {
        const admission = await admitWebRecoveryAttempt(rateInput)
        if (!admission.admitted) return signInFailure()

        const response = await handler(signIn.providerRequest)
        return signIn.valid && response.ok
          ? redactBrowserSessionToken(request, response)
          : signInFailure()
      },
    })
  } catch (error) {
    if (
      error instanceof CredentialLifecycleCapacityError ||
      error instanceof CredentialLifecycleUnavailableError
    ) {
      return signInFailure()
    }
    throw error
  }
}

export function handleAuthGet(request: Request): Promise<Response> {
  if (unsupportedIdentityRequest(request)) {
    return Promise.resolve(unsupportedIdentityMutationResponse())
  }
  return authHandlers()
    .GET(request)
    .then((response) => redactBrowserSessionToken(request, response))
}

export function handleAuthPost(request: Request): Promise<Response> {
  return handleAuthRequest(request, authHandlers().POST)
}

export function handleAuthPatch(request: Request): Promise<Response> {
  if (unsupportedIdentityRequest(request)) {
    return Promise.resolve(unsupportedIdentityMutationResponse())
  }
  return authHandlers().PATCH(request)
}

export function handleAuthPut(request: Request): Promise<Response> {
  if (unsupportedIdentityRequest(request)) {
    return Promise.resolve(unsupportedIdentityMutationResponse())
  }
  return authHandlers().PUT(request)
}

export function handleAuthDelete(request: Request): Promise<Response> {
  if (unsupportedIdentityRequest(request)) {
    return Promise.resolve(unsupportedIdentityMutationResponse())
  }
  return authHandlers().DELETE(request)
}
