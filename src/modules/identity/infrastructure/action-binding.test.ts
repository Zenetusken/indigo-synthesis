import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetServerConfigForTests } from '@/platform/config/server'
import {
  issueCheckedSignOutActionBinding,
  issueEmailSignInActionBinding,
  verifyCheckedSignOutActionBinding,
  verifyEmailSignInActionBinding,
} from './action-binding'

const now = new Date('2026-07-15T12:00:00.000Z')
const sessionExpiresAt = new Date('2026-07-16T12:00:00.000Z')
const context = {
  expectedEpoch: 'private-epoch-019f1234',
  sessionId: 'private-session-019f5678',
  actorUserId: 'private-actor-019f9012',
} as const

function issue() {
  return issueCheckedSignOutActionBinding({ ...context, sessionExpiresAt }, now)
}

describe('checked sign-out action binding', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/indigo_action_binding_test')
    vi.stubEnv('BETTER_AUTH_SECRET', 'action-binding-test-secret-at-least-32-characters')
    vi.stubEnv('BETTER_AUTH_URL', 'http://127.0.0.1:3000')
    vi.stubEnv('INDIGO_CONTENT_MODE', 'development')
    vi.stubEnv('NODE_ENV', 'test')
    resetServerConfigForTests()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    resetServerConfigForTests()
  })

  it('carries only version, purpose, expiry, and a MAC while binding server-only identity', () => {
    const binding = issue()

    expect(binding.split('.')).toHaveLength(4)
    expect(binding).toMatch(
      /^iab1\.checked-sign-out\.[1-9a-z][0-9a-z]*\.[A-Za-z0-9_-]{43}$/,
    )
    expect(verifyCheckedSignOutActionBinding(binding, context, now)).toBe(true)

    const transport = JSON.stringify({ binding })
    expect(transport).not.toContain(context.expectedEpoch)
    expect(transport).not.toContain(context.sessionId)
    expect(transport).not.toContain(context.actorUserId)
  })

  it('rejects a tampered MAC and a cross-purpose transport', () => {
    const binding = issue()
    const finalCharacter = binding.at(-1)
    const tampered = `${binding.slice(0, -1)}${finalCharacter === 'A' ? 'B' : 'A'}`
    const crossPurpose = binding.replace('.checked-sign-out.', '.owner-recovery.')

    expect(verifyCheckedSignOutActionBinding(tampered, context, now)).toBe(false)
    expect(verifyCheckedSignOutActionBinding(crossPurpose, context, now)).toBe(false)
  })

  it.each([
    ['epoch', { ...context, expectedEpoch: 'replacement-epoch' }],
    ['session', { ...context, sessionId: 'replacement-session' }],
    ['actor', { ...context, actorUserId: 'replacement-actor' }],
  ])('rejects a stale or mismatched %s binding context', (_label, replacement) => {
    expect(verifyCheckedSignOutActionBinding(issue(), replacement, now)).toBe(false)
  })

  it('is valid through a bounded post-expiry cleanup window and then expires', () => {
    const binding = issue()

    expect(
      verifyCheckedSignOutActionBinding(
        binding,
        context,
        new Date(sessionExpiresAt.getTime() - 1_000),
      ),
    ).toBe(true)
    expect(verifyCheckedSignOutActionBinding(binding, context, sessionExpiresAt)).toBe(
      true,
    )
    expect(
      verifyCheckedSignOutActionBinding(
        binding,
        context,
        new Date(sessionExpiresAt.getTime() + 15 * 60 * 1_000),
      ),
    ).toBe(false)
  })

  it('will not issue after the post-expiry cleanup window', () => {
    expect(() =>
      issueCheckedSignOutActionBinding(
        {
          ...context,
          sessionExpiresAt: new Date(now.getTime() - 15 * 60 * 1_000),
        },
        now,
      ),
    ).toThrow('cleanup window')
  })

  it.each([
    null,
    '',
    'iab1.checked-sign-out.0.invalid',
    'iab1.checked-sign-out.01.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'iab1.checked-sign-out.zzzzzzzzzzzzzzzz.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'iab1.owner-recovery.abc.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'iab1.checked-sign-out.abc.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.extra',
  ])('fails closed for malformed transport %#', (binding) => {
    expect(verifyCheckedSignOutActionBinding(binding, context, now)).toBe(false)
  })
})

describe('email sign-in action binding', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/indigo_action_binding_test')
    vi.stubEnv('BETTER_AUTH_SECRET', 'action-binding-test-secret-at-least-32-characters')
    vi.stubEnv('BETTER_AUTH_URL', 'http://127.0.0.1:3000')
    vi.stubEnv('INDIGO_CONTENT_MODE', 'development')
    vi.stubEnv('NODE_ENV', 'test')
    resetServerConfigForTests()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    resetServerConfigForTests()
  })

  it('binds a bounded page generation without transporting the raw epoch', () => {
    const binding = issueEmailSignInActionBinding(
      { expectedEpoch: context.expectedEpoch },
      now,
    )

    expect(binding).toMatch(/^iab1\.email-sign-in\.[1-9a-z][0-9a-z]*\.[A-Za-z0-9_-]{43}$/)
    expect(binding).not.toContain(context.expectedEpoch)
    expect(
      verifyEmailSignInActionBinding(
        binding,
        { expectedEpoch: context.expectedEpoch },
        new Date(now.getTime() + 14 * 60 * 1_000),
      ),
    ).toBe(true)
  })

  it('rejects stale generations, wrong-purpose bindings, tampering, and expiry', () => {
    const binding = issueEmailSignInActionBinding(
      { expectedEpoch: context.expectedEpoch },
      now,
    )
    const tampered = `${binding.slice(0, -1)}${binding.endsWith('A') ? 'B' : 'A'}`

    expect(
      verifyEmailSignInActionBinding(binding, { expectedEpoch: 'replacement' }, now),
    ).toBe(false)
    expect(
      verifyEmailSignInActionBinding(
        issue(),
        { expectedEpoch: context.expectedEpoch },
        now,
      ),
    ).toBe(false)
    expect(
      verifyEmailSignInActionBinding(
        tampered,
        { expectedEpoch: context.expectedEpoch },
        now,
      ),
    ).toBe(false)
    expect(
      verifyEmailSignInActionBinding(
        binding,
        { expectedEpoch: context.expectedEpoch },
        new Date(now.getTime() + 15 * 60 * 1_000),
      ),
    ).toBe(false)
  })
})
