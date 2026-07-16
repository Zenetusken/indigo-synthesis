import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetServerConfigForTests } from '@/platform/config/server'
import {
  issueCheckedSignOutActionBinding,
  issueEmailSignInActionBinding,
  issueLocalUserCreateActionBinding,
  issueMemberResetIssueActionBinding,
  issueMemberResetRedemptionActionBinding,
  issueOwnerBootstrapActionBinding,
  issueOwnerRecoveryRedemptionActionBinding,
  verifyCheckedSignOutActionBinding,
  verifyEmailSignInActionBinding,
  verifyLocalUserCreateActionBinding,
  verifyMemberResetIssueActionBinding,
  verifyMemberResetRedemptionActionBinding,
  verifyOwnerBootstrapActionBinding,
  verifyOwnerRecoveryRedemptionActionBinding,
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

describe('authenticated settings action bindings', () => {
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

  const localUserContext = {
    ...context,
    targetUserId: 'preallocated-local-user-019f3456',
  } as const
  const memberResetContext = {
    ...context,
    targetUserId: 'existing-member-019f7890',
  } as const

  it('binds local-user creation to epoch, session, owner, and preallocated target', () => {
    const binding = issueLocalUserCreateActionBinding(
      { ...localUserContext, sessionExpiresAt },
      now,
    )

    expect(binding).toMatch(
      /^iab1\.local-user-create\.[1-9a-z][0-9a-z]*\.[A-Za-z0-9_-]{43}$/,
    )
    expect(verifyLocalUserCreateActionBinding(binding, localUserContext, now)).toBe(true)

    const transport = JSON.stringify({ binding })
    for (const privateIdentity of Object.values(localUserContext)) {
      expect(transport).not.toContain(privateIdentity)
    }
    for (const replacement of [
      { ...localUserContext, expectedEpoch: 'replacement-epoch' },
      { ...localUserContext, sessionId: 'replacement-session' },
      { ...localUserContext, actorUserId: 'replacement-owner' },
      { ...localUserContext, targetUserId: 'replacement-target' },
    ]) {
      expect(verifyLocalUserCreateActionBinding(binding, replacement, now)).toBe(false)
    }
  })

  it('purpose-separates member reset issuance and binds the exact target', () => {
    const binding = issueMemberResetIssueActionBinding(
      { ...memberResetContext, sessionExpiresAt },
      now,
    )

    expect(binding).toMatch(
      /^iab1\.member-reset-issue\.[1-9a-z][0-9a-z]*\.[A-Za-z0-9_-]{43}$/,
    )
    expect(verifyMemberResetIssueActionBinding(binding, memberResetContext, now)).toBe(
      true,
    )
    expect(
      verifyMemberResetIssueActionBinding(
        binding,
        { ...memberResetContext, targetUserId: 'another-member' },
        now,
      ),
    ).toBe(false)
    expect(verifyLocalUserCreateActionBinding(binding, localUserContext, now)).toBe(false)
  })

  it('expires at the earlier of fifteen minutes and the authenticated session', () => {
    const shortSessionExpiry = new Date(now.getTime() + 5 * 60 * 1_000)
    const shortBinding = issueLocalUserCreateActionBinding(
      { ...localUserContext, sessionExpiresAt: shortSessionExpiry },
      now,
    )
    const longBinding = issueMemberResetIssueActionBinding(
      { ...memberResetContext, sessionExpiresAt },
      now,
    )

    expect(
      verifyLocalUserCreateActionBinding(
        shortBinding,
        localUserContext,
        new Date(shortSessionExpiry.getTime() - 1_000),
      ),
    ).toBe(true)
    expect(
      verifyLocalUserCreateActionBinding(
        shortBinding,
        localUserContext,
        shortSessionExpiry,
      ),
    ).toBe(false)
    expect(
      verifyMemberResetIssueActionBinding(
        longBinding,
        memberResetContext,
        new Date(now.getTime() + 15 * 60 * 1_000),
      ),
    ).toBe(false)
  })

  it('refuses to issue either authenticated form binding for an expired session', () => {
    const expiredSession = new Date(now.getTime() - 1)

    expect(() =>
      issueLocalUserCreateActionBinding(
        { ...localUserContext, sessionExpiresAt: expiredSession },
        now,
      ),
    ).toThrow('expired session')
    expect(() =>
      issueMemberResetIssueActionBinding(
        { ...memberResetContext, sessionExpiresAt: expiredSession },
        now,
      ),
    ).toThrow('expired session')
  })
})

describe('owner bootstrap action binding', () => {
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

  it('binds only the open installation generation under its own purpose', () => {
    const binding = issueOwnerBootstrapActionBinding(
      { expectedEpoch: context.expectedEpoch },
      now,
    )

    expect(binding).toMatch(
      /^iab1\.owner-bootstrap\.[1-9a-z][0-9a-z]*\.[A-Za-z0-9_-]{43}$/,
    )
    expect(binding).not.toContain(context.expectedEpoch)
    expect(
      verifyOwnerBootstrapActionBinding(
        binding,
        { expectedEpoch: context.expectedEpoch },
        now,
      ),
    ).toBe(true)
    expect(
      verifyEmailSignInActionBinding(
        binding,
        { expectedEpoch: context.expectedEpoch },
        now,
      ),
    ).toBe(false)
  })

  it('rejects a replaced generation, tampering, and expiry', () => {
    const binding = issueOwnerBootstrapActionBinding(
      { expectedEpoch: context.expectedEpoch },
      now,
    )
    const tampered = `${binding.slice(0, -1)}${binding.endsWith('A') ? 'B' : 'A'}`

    expect(
      verifyOwnerBootstrapActionBinding(
        binding,
        { expectedEpoch: 'replacement-generation' },
        now,
      ),
    ).toBe(false)
    expect(
      verifyOwnerBootstrapActionBinding(
        tampered,
        { expectedEpoch: context.expectedEpoch },
        now,
      ),
    ).toBe(false)
    expect(
      verifyOwnerBootstrapActionBinding(
        binding,
        { expectedEpoch: context.expectedEpoch },
        new Date(now.getTime() + 15 * 60 * 1_000),
      ),
    ).toBe(false)
  })
})

describe('public recovery redemption action bindings', () => {
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

  it('binds both public forms to one epoch under mutually exclusive purposes', () => {
    const bindingContext = { expectedEpoch: context.expectedEpoch }
    const memberBinding = issueMemberResetRedemptionActionBinding(bindingContext, now)
    const ownerBinding = issueOwnerRecoveryRedemptionActionBinding(bindingContext, now)

    expect(memberBinding).toMatch(
      /^iab1\.member-reset-redemption\.[1-9a-z][0-9a-z]*\.[A-Za-z0-9_-]{43}$/,
    )
    expect(ownerBinding).toMatch(
      /^iab1\.owner-recovery-redemption\.[1-9a-z][0-9a-z]*\.[A-Za-z0-9_-]{43}$/,
    )
    expect(JSON.stringify({ memberBinding, ownerBinding })).not.toContain(
      context.expectedEpoch,
    )
    expect(
      verifyMemberResetRedemptionActionBinding(memberBinding, bindingContext, now),
    ).toBe(true)
    expect(
      verifyOwnerRecoveryRedemptionActionBinding(ownerBinding, bindingContext, now),
    ).toBe(true)
    expect(
      verifyOwnerRecoveryRedemptionActionBinding(memberBinding, bindingContext, now),
    ).toBe(false)
    expect(
      verifyMemberResetRedemptionActionBinding(ownerBinding, bindingContext, now),
    ).toBe(false)
    expect(verifyOwnerBootstrapActionBinding(ownerBinding, bindingContext, now)).toBe(
      false,
    )
  })

  it('rejects a changed generation, tampering, and the exact fifteen-minute edge', () => {
    const bindingContext = { expectedEpoch: context.expectedEpoch }
    const memberBinding = issueMemberResetRedemptionActionBinding(bindingContext, now)
    const tampered = `${memberBinding.slice(0, -1)}${memberBinding.endsWith('A') ? 'B' : 'A'}`

    expect(
      verifyMemberResetRedemptionActionBinding(
        memberBinding,
        { expectedEpoch: 'replacement-generation' },
        now,
      ),
    ).toBe(false)
    expect(verifyMemberResetRedemptionActionBinding(tampered, bindingContext, now)).toBe(
      false,
    )
    expect(
      verifyMemberResetRedemptionActionBinding(
        memberBinding,
        bindingContext,
        new Date(now.getTime() + 15 * 60 * 1_000),
      ),
    ).toBe(false)
  })
})
