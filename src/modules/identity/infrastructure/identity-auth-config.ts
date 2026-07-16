import type { BetterAuthOptions } from 'better-auth/minimal'
import { getServerConfig } from '@/platform/config/server'
import { account, session, user, verification } from '@/platform/db/schema'
import { authClientAddressHeaders, authTrustedProxyCidrs } from './client-address'

export const identityAuthDatabaseSchema = Object.freeze({
  user,
  session,
  account,
  verification,
})

/**
 * The singleton read provider and every request-scoped mutation provider must share
 * one security policy. Database transaction ownership and plugins are deliberately
 * supplied by each caller because those are the two intentional lifecycle differences.
 */
export type IdentityAuthRuntimeMode = 'read-only' | 'scoped-mutation'

export function createIdentityAuthOptions(
  mode: IdentityAuthRuntimeMode,
): Omit<BetterAuthOptions, 'database' | 'plugins'> {
  const config = getServerConfig()

  return {
    appName: 'Indigo Synthesis',
    baseURL: config.appOrigin,
    secret: config.authSecret,
    trustedOrigins: [config.appOrigin],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    session: {
      // Session reads are observational. Identity owns bounded expiry cleanup and every
      // credential mutation; Better Auth must never refresh or delete rows on a read path.
      deferSessionRefresh: true,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
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
      ...(mode === 'read-only' ? ['/sign-in/email', '/sign-out'] : []),
    ],
    rateLimit: {
      enabled: config.nodeEnv === 'production',
      // The application-owned sign-in limiter is PostgreSQL-backed, account-aware, and
      // shared across processes. A second sign-in rule would create divergent rejection
      // bodies and process-local budgets; unrelated Better Auth endpoints retain theirs.
      customRules: { '/sign-in/email': false },
    },
    advanced: {
      // Better Auth otherwise skips these checks automatically under NODE_ENV=test.
      // Pinning false keeps the security boundary active in every executable proof.
      disableOriginCheck: false,
      disableCSRFCheck: false,
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
  }
}
