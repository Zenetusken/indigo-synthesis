import { toNextJsHandler } from 'better-auth/next-js'
import { eq, sql } from 'drizzle-orm'
import { getServerConfig } from '@/platform/config/server'
import { getDb } from '@/platform/db/client'
import { user } from '@/platform/db/schema'
import { getAuth } from '../infrastructure/auth'
import { resolveRequestClientAddress } from '../infrastructure/client-address'
import { withCredentialLifecycleLock } from '../infrastructure/credential-lifecycle-lock'

type AuthHandler = (request: Request) => Promise<Response>

function authHandlers() {
  return toNextJsHandler(getAuth())
}

function isEmailSignIn(request: Request): boolean {
  return (
    request.method === 'POST' &&
    new URL(request.url).pathname.replace(/\/+$/, '').endsWith('/sign-in/email')
  )
}

async function signInEmail(request: Request): Promise<string | null> {
  try {
    const body = (await request.clone().json()) as { email?: unknown }
    if (typeof body.email !== 'string') return null
    const email = body.email.trim().toLowerCase()
    return email && email.length <= 320 ? email : null
  } catch {
    return null
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

export async function handleAuthRequest(
  request: Request,
  handler: AuthHandler,
): Promise<Response> {
  const config = getServerConfig()
  if (
    config.nodeEnv === 'production' &&
    config.secureCookies &&
    !resolveRequestClientAddress(request.headers)
  ) {
    return forwardingFailure()
  }

  if (!isEmailSignIn(request)) return handler(request)

  const email = await signInEmail(request)
  if (!email) return handler(request)
  const userId = await userIdForEmail(email)
  if (!userId) return handler(request)

  return withCredentialLifecycleLock(userId, () => handler(request))
}

export function handleAuthGet(request: Request): Promise<Response> {
  return authHandlers().GET(request)
}

export function handleAuthPost(request: Request): Promise<Response> {
  return handleAuthRequest(request, authHandlers().POST)
}

export function handleAuthPatch(request: Request): Promise<Response> {
  return authHandlers().PATCH(request)
}

export function handleAuthPut(request: Request): Promise<Response> {
  return authHandlers().PUT(request)
}

export function handleAuthDelete(request: Request): Promise<Response> {
  return authHandlers().DELETE(request)
}
