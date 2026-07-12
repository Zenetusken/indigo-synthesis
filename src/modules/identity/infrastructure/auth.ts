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
