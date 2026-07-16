import { verifyPassword } from 'better-auth/crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetServerConfigForTests } from '@/platform/config/server'
import {
  captureRecoveryCommandEntry,
  memberResetCodeIdentity,
  memberResetStoredValue,
  memberResetStoredValueMatches,
  ownerRecoveryCodeIdentity,
  ownerRecoveryStoredValueMatches,
  parseMemberResetRedemptionInput,
  parseOwnerRecoveryHostRedemptionInput,
  parseOwnerRecoveryWebRedemptionInput,
  prepareMemberResetIssuance,
  prepareMemberResetRedemption,
  prepareOwnerRecoveryIssuance,
  prepareOwnerRecoveryRedemption,
  RecoveryPreparationError,
  recoveryPreparationPolicy,
} from './recovery-preparation'

const commandEnteredAt = new Date('2026-07-15T12:34:56.789Z')

beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/indigo_recovery_unit')
  vi.stubEnv('BETTER_AUTH_SECRET', 'recovery-preparation-test-secret-at-least-32-chars')
  vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:3000')
  vi.stubEnv('INDIGO_CONTENT_MODE', 'development')
  vi.stubEnv('NODE_ENV', 'test')
  resetServerConfigForTests()
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetServerConfigForTests()
})

describe('recovery preparation', () => {
  it('captures one immutable-by-copy command-entry timestamp and rejects invalid clocks', () => {
    const input = new Date(commandEnteredAt)
    const captured = captureRecoveryCommandEntry(input)
    input.setUTCFullYear(2030)

    expect(captured).toEqual(commandEnteredAt)
    expect(captured).not.toBe(input)
    expect(() => captureRecoveryCommandEntry(new Date(Number.NaN))).toThrow(TypeError)
    expect(() => captureRecoveryCommandEntry(new Date(-1))).toThrow(TypeError)
  })

  it('prepares member issuance with fixed policy, one-use material, and audit IDs', () => {
    const prepared = prepareMemberResetIssuance({
      targetUserId: '01900000-0000-7000-8000-000000000002',
      commandEnteredAt,
    })

    expect(prepared.code).toMatch(/^indigo_m1_[A-Za-z0-9_-]{43}$/)
    expect(prepared.identifier).toBe(
      'indigo:member-reset:01900000-0000-7000-8000-000000000002',
    )
    expect(prepared.expiresAt).toEqual(new Date('2026-07-15T12:49:56.789Z'))
    expect(prepared.audit).toEqual({
      eventType: 'member-reset-issued',
      entityType: 'member-reset',
      entityId: prepared.resetId,
      outcome: 'issued',
      expiresAt: prepared.expiresAt.toISOString(),
    })
    expect(prepared.auditEventId).not.toBe(prepared.resetId)
    expect(memberResetStoredValueMatches(prepared.code, prepared.storedValue)).toBe(true)
    expect(ownerRecoveryStoredValueMatches(prepared.code, prepared.storedValue)).toBe(
      false,
    )
    expect(recoveryPreparationPolicy.memberReset.issuanceCooldownMilliseconds).toBe(
      30_000,
    )
  })

  it('prepares strict owner issuance and enforces both TTL ranges', () => {
    const prepared = prepareOwnerRecoveryIssuance({
      ownerUserId: '01900000-0000-7000-8000-000000000001',
      ownerEmail: ' Owner@Example.TEST ',
      ttlMinutes: 60,
      commandEnteredAt,
    })

    expect(prepared.normalizedOwnerEmail).toBe('owner@example.test')
    expect(prepared.code).toMatch(/^indigo_r1_[A-Za-z0-9_-]{43}$/)
    expect(prepared.expiresAt).toEqual(new Date('2026-07-15T13:34:56.789Z'))
    expect(ownerRecoveryStoredValueMatches(prepared.code, prepared.storedValue)).toBe(
      true,
    )
    expect(() =>
      prepareOwnerRecoveryIssuance({
        ownerUserId: prepared.ownerUserId,
        ownerEmail: 'not-an-email',
        ttlMinutes: 15,
        commandEnteredAt,
      }),
    ).toThrow(RecoveryPreparationError)
    expect(() =>
      prepareMemberResetIssuance({
        targetUserId: prepared.ownerUserId,
        ttlMinutes: 4,
        commandEnteredAt,
      }),
    ).toThrow(expect.objectContaining({ code: 'member-reset.ttl-invalid' }))
    expect(() =>
      prepareOwnerRecoveryIssuance({
        ownerUserId: prepared.ownerUserId,
        ownerEmail: prepared.normalizedOwnerEmail,
        ttlMinutes: 61,
        commandEnteredAt,
      }),
    ).toThrow(expect.objectContaining({ code: 'owner-recovery.ttl-invalid' }))
  })

  it('uses distinct HMAC namespaces for stored values and authority identities', () => {
    const code = 'same-submitted-code'
    const memberIdentity = memberResetCodeIdentity(code)
    const ownerIdentity = ownerRecoveryCodeIdentity(code)

    expect(memberIdentity).toMatch(/^[0-9a-f]{64}$/)
    expect(ownerIdentity).toMatch(/^[0-9a-f]{64}$/)
    expect(memberIdentity).not.toBe(ownerIdentity)
    expect(memberIdentity).not.toBe(memberResetStoredValue(code).split(':')[1])
  })

  it('bounds public redemption input and always prepares a password hash', async () => {
    const memberParsed = parseMemberResetRedemptionInput({
      email: ' Member@Example.TEST ',
      code: 'x'.repeat(257),
      newPassword: 'short',
    })
    const ownerParsed = parseOwnerRecoveryWebRedemptionInput({
      ownerEmail: null,
      code: null,
      newPassword: null,
    })
    const member = await prepareMemberResetRedemption(memberParsed, commandEnteredAt)
    const owner = await prepareOwnerRecoveryRedemption(ownerParsed, commandEnteredAt)

    expect(memberParsed).toMatchObject({
      normalizedEmail: 'member@example.test',
      passwordIsValid: false,
    })
    expect(memberParsed.submittedCode.length).toBeLessThanOrEqual(
      recoveryPreparationPolicy.maximumCodeCharacters,
    )
    expect(ownerParsed).toMatchObject({
      normalizedEmail: 'invalid-email',
      passwordIsValid: false,
    })
    expect(member.codeIdentity).not.toBe(owner.codeIdentity)
    expect(await verifyPassword({ hash: member.passwordHash, password: 'short' })).toBe(
      false,
    )
    expect(memberResetStoredValueMatches('x'.repeat(257), 'malformed')).toBe(false)
    expect(ownerRecoveryStoredValueMatches(null, null)).toBe(false)
  })

  it('keeps host parsing detailed while accepting a valid bounded password', async () => {
    const parsed = parseOwnerRecoveryHostRedemptionInput({
      ownerEmail: ' Owner@Example.TEST ',
      code: 'host-issued-code',
      newPassword: 'a sufficiently long replacement',
    })
    const prepared = await prepareOwnerRecoveryRedemption(parsed, commandEnteredAt)

    expect(parsed.normalizedEmail).toBe('owner@example.test')
    expect(prepared.passwordIsValid).toBe(true)
    expect(
      await verifyPassword({
        hash: prepared.passwordHash,
        password: 'a sufficiently long replacement',
      }),
    ).toBe(true)
    expect(() =>
      parseOwnerRecoveryHostRedemptionInput({
        ownerEmail: 'owner@example.test',
        code: 'host-issued-code',
        newPassword: 'short',
      }),
    ).toThrow(expect.objectContaining({ code: 'owner-recovery.password-invalid' }))
  })
})
