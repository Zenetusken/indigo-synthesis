import { getServerConfig } from '@/platform/config/server'
import { identityActionBindingHeader } from '../application/action-binding'
import { handleIdentityGetSession } from '../infrastructure/auth'
import { resolveWebClientAddress } from '../infrastructure/client-address'
import { admitCredentialLoadShedder } from '../infrastructure/credential-load-shedder'
import {
  createEmailSignInMutationCommand,
  emailSignInMutationCommandView,
  type IdentityAuthMutationPort,
} from './auth-mutation-port'

const allowedExternalIdentityRequests = new Set([
  'GET /api/auth/get-session',
  'POST /api/auth/sign-in/email',
  'POST /api/auth/sign-out',
])

function unsupportedIdentityRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname
  return !allowedExternalIdentityRequests.has(`${request.method} ${pathname}`)
}

function unsupportedIdentityMutationResponse(): Response {
  return Response.json({ code: 'NOT_FOUND', message: 'Not found.' }, { status: 404 })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function browserSafeUser(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  const safe: Record<string, unknown> = {}
  for (const field of [
    'id',
    'name',
    'email',
    'emailVerified',
    'image',
    'createdAt',
    'updatedAt',
  ] as const) {
    if (field in value) safe[field] = value[field]
  }
  return safe
}

function browserSafeSession(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  const safe: Record<string, unknown> = {}
  for (const field of ['expiresAt', 'createdAt', 'updatedAt'] as const) {
    if (field in value) safe[field] = value[field]
  }
  return safe
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
  const path = new URL(request.url).pathname
  if (path !== '/api/auth/sign-in/email' && path !== '/api/auth/get-session') {
    return response
  }

  const body: unknown = await response.json()
  if (!isRecord(body)) return jsonResponseWithProviderHeaders(response, body)

  if (path === '/api/auth/sign-in/email') {
    return jsonResponseWithProviderHeaders(response, {
      redirect: body.redirect === true,
      url: typeof body.url === 'string' ? body.url : null,
      user: browserSafeUser(body.user),
    })
  }

  return jsonResponseWithProviderHeaders(response, {
    session: browserSafeSession(body.session),
    user: browserSafeUser(body.user),
  })
}

function isEmailSignIn(request: Request): boolean {
  return (
    request.method === 'POST' &&
    new URL(request.url).pathname === '/api/auth/sign-in/email'
  )
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
  mutations: IdentityAuthMutationPort,
): Promise<Response> {
  // GET has a deliberately narrower read-only entry point. Never let a caller of the
  // mutation dispatcher turn an allowed read route into checked sign-out.
  if (request.method !== 'POST' || unsupportedIdentityRequest(request)) {
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
    return mutations.checkedSignOut({
      actionBinding: request.headers.get(identityActionBindingHeader),
      request,
      signal: request.signal,
    })
  }

  const command = await createEmailSignInMutationCommand({
    actionBinding: request.headers.get(identityActionBindingHeader),
    clientAddress,
    request,
  })
  const commandView = emailSignInMutationCommandView(command)
  if (
    !admitCredentialLoadShedder({
      purpose: 'sign-in',
      email: commandView.rateLimitEmail,
      clientAddress,
    }).admitted
  ) {
    return signInFailure()
  }
  const response = await mutations.emailSignIn(command)
  return commandView.syntacticallyValid && response.ok
    ? redactBrowserSessionToken(request, response)
    : signInFailure()
}

export function handleAuthGet(request: Request): Promise<Response> {
  if (unsupportedIdentityRequest(request)) {
    return Promise.resolve(unsupportedIdentityMutationResponse())
  }
  return handleIdentityGetSession(request).then((response) =>
    redactBrowserSessionToken(request, response),
  )
}

export function handleAuthPost(
  request: Request,
  mutations: IdentityAuthMutationPort,
): Promise<Response> {
  return handleAuthRequest(request, mutations)
}

export function handleAuthPatch(request: Request): Promise<Response> {
  if (unsupportedIdentityRequest(request)) {
    return Promise.resolve(unsupportedIdentityMutationResponse())
  }
  return Promise.resolve(unsupportedIdentityMutationResponse())
}

export function handleAuthPut(request: Request): Promise<Response> {
  if (unsupportedIdentityRequest(request)) {
    return Promise.resolve(unsupportedIdentityMutationResponse())
  }
  return Promise.resolve(unsupportedIdentityMutationResponse())
}

export function handleAuthDelete(request: Request): Promise<Response> {
  if (unsupportedIdentityRequest(request)) {
    return Promise.resolve(unsupportedIdentityMutationResponse())
  }
  return Promise.resolve(unsupportedIdentityMutationResponse())
}
