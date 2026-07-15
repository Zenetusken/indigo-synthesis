import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { betterAuth } from 'better-auth/minimal'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  createIdentityAuthOptions,
  identityAuthDatabaseSchema,
} from './identity-auth-config'
import { checkedIdentitySignOutPlugin } from './session-cookie-endpoints'

export interface ScopedIdentityMutationGateway {
  signInEmail(request: Request): Promise<Response>
  checkedSignOut(request: Request): Promise<Response>
}

function assertProviderRoute(request: Request, path: string): void {
  if (request.method !== 'POST' || new URL(request.url).pathname !== `/api/auth${path}`) {
    throw new TypeError('Scoped Identity auth request does not match its gateway route.')
  }
}

/**
 * Builds a one-request Better Auth mutation gateway over the caller's already-scoped
 * Drizzle database. Better Auth must not start a nested transaction: the application
 * coordination layer owns the surrounding UoW and its commit/rollback barrier.
 */
export function createScopedIdentityMutationGateway<
  TSchema extends Record<string, unknown>,
>(scopedDatabase: NodePgDatabase<TSchema>): ScopedIdentityMutationGateway {
  const auth = betterAuth({
    ...createIdentityAuthOptions('scoped-mutation'),
    database: drizzleAdapter(scopedDatabase, {
      provider: 'pg',
      schema: identityAuthDatabaseSchema,
      transaction: false,
    }),
    plugins: [checkedIdentitySignOutPlugin()],
  })

  return Object.freeze({
    async signInEmail(request: Request): Promise<Response> {
      assertProviderRoute(request, '/sign-in/email')
      return auth.handler(request)
    },
    async checkedSignOut(request: Request): Promise<Response> {
      assertProviderRoute(request, '/sign-out')
      return auth.api.signOut({
        request,
        headers: request.headers,
        asResponse: true,
      })
    },
  })
}
