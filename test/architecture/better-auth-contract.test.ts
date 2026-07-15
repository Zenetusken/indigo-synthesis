import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const betterAuthDist = dirname(require.resolve('better-auth'))

function providerRoute(name: 'session' | 'sign-out'): {
  readonly digest: string
  readonly source: string
} {
  const source = readFileSync(
    resolve(betterAuthDist, 'api', 'routes', `${name}.mjs`),
    'utf8',
  )
  return {
    digest: createHash('sha256').update(source).digest('hex'),
    source,
  }
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
    // public mutation must be replaced by Identity's checked implementation later in Stage 3.
    expect(session.source).toContain(
      'if (!deferSessionRefresh || isPostRequest) await ctx.context.internalAdapter.deleteSession',
    )
    expect(session.source).toContain('if (deferSessionRefresh && !isPostRequest)')
    expect(signOut.source).toContain('Failed to delete session from database')
    expect(signOut.source).toContain('return ctx.json({ success: true })')
  })
})
