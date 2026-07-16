import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const betterAuthDist = dirname(require.resolve('better-auth'))
const nestedRequire = createRequire(require.resolve('better-auth'))

function reviewedSource(path: string): {
  readonly digest: string
  readonly source: string
} {
  const source = readFileSync(path, 'utf8')
  return {
    digest: createHash('sha256').update(source).digest('hex'),
    source,
  }
}

function providerRoute(name: 'session' | 'sign-out'): {
  readonly digest: string
  readonly source: string
} {
  return reviewedSource(resolve(betterAuthDist, 'api', 'routes', `${name}.mjs`))
}

describe('pinned Better Auth lifecycle contract', () => {
  it('pins the manually reviewed provider routes that can mutate session rows', () => {
    const session = providerRoute('session')
    const signOut = providerRoute('sign-out')

    expect(session.digest).toBe(
      'ceae5538362c44895838ff801d5c9e33c0c9548c0eb6edeca6f9bce7e009d2da',
    )
    expect(signOut.digest).toBe(
      'a130b00bd64c2e42bf2e7a1204e76b1d7493f4599db9f0bd354032a8c0bb24c3',
    )

    // These assertions document why the exact source is pinned. GET remains read-only only when
    // Indigo supplies its fixed-expiry options; provider sign-out swallows delete failures, so the
    // public mutation is therefore replaced by Identity's checked Stage 3 implementation.
    expect(session.source).toContain(
      'if (!deferSessionRefresh || isPostRequest) await ctx.context.internalAdapter.deleteSession',
    )
    expect(session.source).toContain('if (deferSessionRefresh && !isPostRequest)')
    expect(signOut.source).toContain('Failed to delete session from database')
    expect(signOut.source).toContain('return ctx.json({ success: true })')
  })

  it('pins every low-level source contract used by scoped auth and checked cookies', () => {
    const sources = {
      signIn: reviewedSource(resolve(betterAuthDist, 'api/routes/sign-in.mjs')),
      origin: reviewedSource(resolve(betterAuthDist, 'api/middlewares/origin-check.mjs')),
      dispatch: reviewedSource(resolve(betterAuthDist, 'api/dispatch.mjs')),
      directEndpoints: reviewedSource(
        resolve(betterAuthDist, 'api/to-auth-endpoints.mjs'),
      ),
      cookies: reviewedSource(resolve(betterAuthDist, 'cookies/index.mjs')),
      nextCookies: reviewedSource(resolve(betterAuthDist, 'integrations/next-js.mjs')),
      drizzle: reviewedSource(nestedRequire.resolve('@better-auth/drizzle-adapter')),
      coreAdapter: reviewedSource(
        resolve(
          dirname(nestedRequire.resolve('@better-auth/core')),
          'db/adapter/factory.mjs',
        ),
      ),
      callContext: reviewedSource(
        resolve(dirname(nestedRequire.resolve('better-call')), 'context.mjs'),
      ),
    }

    expect(
      Object.fromEntries(
        Object.entries(sources).map(([name, source]) => [name, source.digest]),
      ),
    ).toEqual({
      signIn: 'd65ff51abf5e4394b0bfe4cbf29f4fa9094db7cdb16e5cc0816e53e5d2dd42a5',
      origin: '103714fc95928483d5f00e44a1b9782de98bbc8e3a1510257d410f681f3c2006',
      dispatch: '18567f3d00a505d912edf655d881695302aefce4ab641648a5ef67452c04c1b0',
      directEndpoints: 'bdd6ee0fee9dd3c0467c26c86612f74750d1618bbec1f1421c575efb7e468ea6',
      cookies: '675b62bc009e355d6a4f1fdc64077f80ff26dcd6542b9b709d716666d5953c61',
      nextCookies: '9771fc27835847c4f3152e33e836fd8e466c45c07eeb79d83da3260ad3fd4489',
      drizzle: '9cf371cfa33a0a611dea978e5a3bee6a018927974831190c6ff201d827315ebf',
      coreAdapter: '74f6a84c607c73b4e2b6c9fd93768507231c924bcfa6e140d1677ed54795dd0a',
      callContext: '473954515dcc93fbd826ff9e054fabd5891460e16a0cb8b0b1171f59c8ab495b',
    })

    expect(sources.signIn.source).toContain('await setSessionCookie(ctx')
    expect(sources.origin.source).toContain('if (!ctx.request) return')
    expect(sources.dispatch.source).toContain(
      'headers: input.headers ? new Headers(input.headers) : void 0',
    )
    expect(sources.directEndpoints.source).toContain(
      'Pass `headers: request.headers` (or `request`)',
    )
    expect(sources.cookies.source).toContain(
      'expireCookie(ctx, ctx.context.authCookies.sessionToken)',
    )
    expect(sources.drizzle.source).toContain('transaction: config.transaction ?? false')
    expect(sources.callContext.source).toContain('getSignedCookie: async')
  })
})
