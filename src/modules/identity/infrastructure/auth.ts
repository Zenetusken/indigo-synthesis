import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { betterAuth } from 'better-auth/minimal'
import { nextCookies } from 'better-auth/next-js'
import { getServerConfig } from '@/platform/config/server'
import { getDb } from '@/platform/db/client'
import { account, session, user, verification } from '@/platform/db/schema'
import { authClientAddressHeaders, authTrustedProxyCidrs } from './client-address'

function createAuth() {
  const config = getServerConfig()

  return betterAuth({
    appName: 'Indigo Synthesis',
    baseURL: config.appOrigin,
    secret: config.authSecret,
    trustedOrigins: [config.appOrigin],
    database: drizzleAdapter(getDb(), {
      provider: 'pg',
      schema: { user, session, account, verification },
      transaction: true,
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    // Indigo exposes only get-session, sign-in/email, and sign-out through its external
    // auth handler. Keep the provider-level denylist as defense in depth; the handler's
    // exact allowlist also fails closed if Better Auth adds another route later.
    disabledPaths: [
      '/account-info',
      '/callback/:id',
      '/change-email',
      '/change-password',
      '/delete-user',
      '/delete-user/callback',
      '/error',
      '/get-access-token',
      '/link-social',
      '/list-accounts',
      '/list-sessions',
      '/ok',
      '/refresh-token',
      '/request-password-reset',
      '/reset-password',
      '/reset-password/:token',
      '/revoke-other-sessions',
      '/revoke-session',
      '/revoke-sessions',
      '/send-verification-email',
      '/set-password',
      '/sign-in/social',
      '/sign-up/email',
      '/unlink-account',
      '/update-session',
      '/update-user',
      '/verify-email',
      '/verify-password',
    ],
    rateLimit: {
      enabled: config.nodeEnv === 'production',
      // The application-owned sign-in limiter is PostgreSQL-backed, account-aware, and
      // shared across processes. A second sign-in rule would create divergent rejection
      // bodies and process-local budgets; unrelated Better Auth endpoints retain theirs.
      customRules: { '/sign-in/email': false },
    },
    advanced: {
      ipAddress: {
        ipAddressHeaders: [...authClientAddressHeaders],
        trustedProxies: [...authTrustedProxyCidrs],
      },
      useSecureCookies: config.secureCookies,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.secureCookies,
      },
    },
    telemetry: { enabled: false },
    plugins: [nextCookies()],
  })
}

export type IndigoAuth = ReturnType<typeof createAuth>

let authInstance: IndigoAuth | undefined

export function getAuth(): IndigoAuth {
  authInstance ??= createAuth()
  return authInstance
}

export function resetAuthForTests(): void {
  authInstance = undefined
}
