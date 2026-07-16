import { APIError, createAuthEndpoint, originCheckMiddleware } from 'better-auth/api'
import { deleteSessionCookie } from 'better-auth/cookies'

const directServerEndpoint = {
  method: 'POST' as const,
  requireRequest: true,
  requireHeaders: true,
  use: [originCheckMiddleware],
  metadata: { SERVER_ONLY: true },
}

export function identitySessionCookiePlugin() {
  return {
    id: 'indigo-session-cookie',
    endpoints: {
      verifyIdentitySessionCookie: createAuthEndpoint(
        '/indigo/verify-session-cookie',
        directServerEndpoint,
        async (context) => {
          const token = await context.getSignedCookie(
            context.context.authCookies.sessionToken.name,
            context.context.secret,
          )
          return context.json({
            sessionToken: typeof token === 'string' ? token : null,
          })
        },
      ),
      clearProvenAbsentIdentitySession: createAuthEndpoint(
        '/indigo/clear-proven-absent-session',
        directServerEndpoint,
        async (context) => {
          const token = await context.getSignedCookie(
            context.context.authCookies.sessionToken.name,
            context.context.secret,
          )
          if (typeof token !== 'string') {
            throw APIError.from('UNAUTHORIZED', {
              code: 'VERIFIED_SESSION_COOKIE_REQUIRED',
              message: 'A verified session cookie is required.',
            })
          }
          deleteSessionCookie(context)
          return context.json({ success: true })
        },
      ),
    },
  } as const
}

export function checkedIdentitySignOutPlugin() {
  return {
    id: 'indigo-checked-sign-out',
    endpoints: {
      // This key intentionally replaces Better Auth's built-in signOut endpoint. The
      // provider implementation catches deletion failures and still clears the cookie;
      // Indigo must instead keep the browser credential when durable deletion failed.
      signOut: createAuthEndpoint('/sign-out', directServerEndpoint, async (context) => {
        const token = await context.getSignedCookie(
          context.context.authCookies.sessionToken.name,
          context.context.secret,
        )
        if (typeof token !== 'string') {
          throw APIError.from('UNAUTHORIZED', {
            code: 'VERIFIED_SESSION_COOKIE_REQUIRED',
            message: 'A verified session cookie is required.',
          })
        }
        // Better Auth's internal deleteSession first performs a best-effort findMany
        // whose errors are swallowed by deleteWithHooks. Identity configures no database
        // hooks, so use the initialized adapter directly: one exact delete, with every
        // database failure preserved for the outer UoW to roll back.
        await context.context.adapter.delete({
          model: 'session',
          where: [{ field: 'token', value: token }],
        })
        deleteSessionCookie(context)
        return context.json({ success: true })
      }),
    },
  } as const
}
