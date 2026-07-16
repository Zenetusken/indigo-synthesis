import type { QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import {
  captureMemberResetRedemption,
  captureOwnerRecoveryCliRedemption,
  captureOwnerRecoveryIssuance,
  captureOwnerRecoveryWebRedemption,
  type IdentityRecoveryMutationQuery,
  MemberResetRedemptionCapture,
  memberResetRedemptionCaptureView,
  OwnerRecoveryCliRedemptionCapture,
  OwnerRecoveryIssuanceCapture,
  OwnerRecoveryWebRedemptionCapture,
  ownerRecoveryCliRedemptionCaptureView,
  ownerRecoveryIssuanceCaptureView,
  ownerRecoveryWebRedemptionCaptureView,
  RecoveryMutationCaptureInvariantError,
  recheckMemberResetRedemption,
  recheckOwnerRecoveryCliRedemption,
  recheckOwnerRecoveryIssuance,
  recheckOwnerRecoveryWebRedemption,
} from './recovery-mutation'

const epoch = '123e4567-e89b-42d3-a456-426614174000'
const nextEpoch = '223e4567-e89b-42d3-a456-426614174001'
const codeIdentity = 'a'.repeat(64)
const normalizedMemberEmail = 'member@example.test'
const normalizedOwnerEmail = 'owner@example.test'
const commandEnteredAt = new Date('2026-07-15T12:00:00.000Z')
const bootstrapClosedAt = new Date('2026-01-02T00:00:00.000Z')
const createdAt = new Date('2026-01-01T00:00:00.000Z')
const updatedAt = new Date('2026-06-01T00:00:00.000Z')
const expiresAt = new Date('2026-07-15T12:15:00.000Z')

type ResultRow = QueryResultRow & Record<string, unknown>

function resultRows(rows: readonly ResultRow[]): QueryResult<ResultRow> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows: [...rows],
  }
}

function result(row: ResultRow): QueryResult<ResultRow> {
  return resultRows([row])
}

function querySequence(
  ...steps: readonly (ResultRow | Error | Promise<QueryResult<ResultRow>>)[]
): {
  readonly query: ReturnType<typeof vi.fn>
  readonly surface: IdentityRecoveryMutationQuery
} {
  const query = vi.fn()
  for (const step of steps) {
    if (step instanceof Error) query.mockRejectedValueOnce(step)
    else if (step instanceof Promise) query.mockReturnValueOnce(step)
    else query.mockResolvedValueOnce(result(step))
  }
  return { query, surface: { query } as unknown as IdentityRecoveryMutationQuery }
}

function deferredResult(): {
  readonly promise: Promise<QueryResult<ResultRow>>
  readonly resolve: (value: QueryResult<ResultRow>) => void
  readonly reject: (reason: unknown) => void
} {
  let resolve!: (value: QueryResult<ResultRow>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<QueryResult<ResultRow>>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

function timestamp(value: Date, asString = false): Date | string {
  return asString ? value.toISOString() : new Date(value)
}

function user(
  id: string,
  email: string,
  overrides: Record<string, unknown> = {},
  datesAsStrings = false,
): Record<string, unknown> {
  return {
    id,
    name: id === 'owner-user' ? 'Installation Owner' : 'Trainee',
    email,
    emailVerified: false,
    createdAt: timestamp(createdAt, datesAsStrings),
    updatedAt: timestamp(updatedAt, datesAsStrings),
    ...overrides,
  }
}

function credential(
  userId: string,
  overrides: Record<string, unknown> = {},
  datesAsStrings = false,
): Record<string, unknown> {
  return {
    id: `credential-${userId}`,
    accountId: userId,
    providerId: 'credential',
    userId,
    password: `private-password-${userId}`,
    createdAt: timestamp(createdAt, datesAsStrings),
    updatedAt: timestamp(updatedAt, datesAsStrings),
    ...overrides,
  }
}

function memberState(
  overrides: Record<string, unknown> = {},
  datesAsStrings = false,
): Record<string, unknown> {
  return {
    targetUserId: 'member-user',
    activeVerificationId: 'member-verification',
    lastIssuedAt: timestamp(updatedAt, datesAsStrings),
    failedAttempts: 0,
    retryAfter: null,
    lastAttemptAt: null,
    createdAt: timestamp(createdAt, datesAsStrings),
    updatedAt: timestamp(updatedAt, datesAsStrings),
    ...overrides,
  }
}

function verification(
  id: string,
  identifier: string,
  overrides: Record<string, unknown> = {},
  datesAsStrings = false,
): Record<string, unknown> {
  return {
    id,
    identifier,
    value: `private-verification-${id}`,
    expiresAt: timestamp(expiresAt, datesAsStrings),
    createdAt: timestamp(createdAt, datesAsStrings),
    updatedAt: timestamp(updatedAt, datesAsStrings),
    ...overrides,
  }
}

function memberRow(
  input: {
    readonly epoch?: string
    readonly ownerUserId?: string | null
    readonly bootstrapClosedAt?: Date | string | null
    readonly users?: readonly Record<string, unknown>[]
    readonly credentials?: readonly Record<string, unknown>[]
    readonly states?: readonly Record<string, unknown>[]
    readonly verifications?: readonly Record<string, unknown>[]
    readonly datesAsStrings?: boolean
    readonly extra?: Record<string, unknown>
  } = {},
): ResultRow {
  const datesAsStrings = input.datesAsStrings ?? false
  return {
    product_mutation_epoch: input.epoch ?? epoch,
    installation_owner_user_id:
      input.ownerUserId === undefined ? 'owner-user' : input.ownerUserId,
    bootstrap_closed_at:
      input.bootstrapClosedAt === undefined
        ? timestamp(bootstrapClosedAt, datesAsStrings)
        : input.bootstrapClosedAt,
    submitted_user_rows: input.users ?? [
      user('member-user', normalizedMemberEmail, {}, datesAsStrings),
    ],
    credential_rows: input.credentials ?? [credential('member-user', {}, datesAsStrings)],
    member_reset_state_rows: input.states ?? [memberState({}, datesAsStrings)],
    member_reset_verification_rows: input.verifications ?? [
      verification(
        'member-verification',
        'indigo:member-reset:member-user',
        {},
        datesAsStrings,
      ),
    ],
    ...input.extra,
  }
}

function ownerRow(
  input: {
    readonly epoch?: string
    readonly ownerUserId?: string | null
    readonly bootstrapClosedAt?: Date | string | null
    readonly owners?: readonly Record<string, unknown>[]
    readonly submittedEmailUserIds?: readonly string[]
    readonly credentials?: readonly Record<string, unknown>[]
    readonly verifications?: readonly Record<string, unknown>[]
    readonly datesAsStrings?: boolean
    readonly extra?: Record<string, unknown>
  } = {},
): ResultRow {
  const datesAsStrings = input.datesAsStrings ?? false
  return {
    product_mutation_epoch: input.epoch ?? epoch,
    installation_owner_user_id:
      input.ownerUserId === undefined ? 'owner-user' : input.ownerUserId,
    bootstrap_closed_at:
      input.bootstrapClosedAt === undefined
        ? timestamp(bootstrapClosedAt, datesAsStrings)
        : input.bootstrapClosedAt,
    submitted_email_user_ids: input.submittedEmailUserIds ?? ['owner-user'],
    owner_user_rows: input.owners ?? [
      user('owner-user', normalizedOwnerEmail, {}, datesAsStrings),
    ],
    credential_rows: input.credentials ?? [credential('owner-user', {}, datesAsStrings)],
    owner_recovery_verification_rows: input.verifications ?? [
      verification(
        'owner-verification',
        'indigo:owner-recovery:owner-user',
        {},
        datesAsStrings,
      ),
    ],
    ...input.extra,
  }
}

function openOwnerRow(extra: Record<string, unknown> = {}): ResultRow {
  return ownerRow({
    ownerUserId: null,
    bootstrapClosedAt: null,
    owners: [],
    submittedEmailUserIds: [],
    credentials: [],
    verifications: [],
    extra,
  })
}

function captureMember(
  surface: IdentityRecoveryMutationQuery,
  overrides: Partial<Parameters<typeof captureMemberResetRedemption>[1]> = {},
) {
  return captureMemberResetRedemption(surface, {
    normalizedEmail: normalizedMemberEmail,
    codeIdentity,
    commandEnteredAt,
    ...overrides,
  })
}

function captureOwnerWeb(
  surface: IdentityRecoveryMutationQuery,
  overrides: Partial<Parameters<typeof captureOwnerRecoveryWebRedemption>[1]> = {},
) {
  return captureOwnerRecoveryWebRedemption(surface, {
    normalizedEmail: normalizedOwnerEmail,
    codeIdentity,
    commandEnteredAt,
    ...overrides,
  })
}

function captureOwnerCli(
  surface: IdentityRecoveryMutationQuery,
  overrides: Partial<Parameters<typeof captureOwnerRecoveryCliRedemption>[1]> = {},
) {
  return captureOwnerRecoveryCliRedemption(surface, {
    normalizedEmail: normalizedOwnerEmail,
    codeIdentity,
    commandEnteredAt,
    hostInvocationId: 'host-invocation-cli',
    ...overrides,
  })
}

function captureOwnerIssue(
  surface: IdentityRecoveryMutationQuery,
  overrides: Partial<Parameters<typeof captureOwnerRecoveryIssuance>[1]> = {},
) {
  return captureOwnerRecoveryIssuance(surface, {
    normalizedOwnerEmail,
    commandEnteredAt,
    hostInvocationId: 'host-invocation-issue',
    ...overrides,
  })
}

describe('recovery mutation capture', () => {
  it('captures a member redemption with one bounded C-ordered statement and an opaque view', async () => {
    const { query, surface } = querySequence(memberRow())

    const capture = await captureMember(surface)
    const view = memberResetRedemptionCaptureView(capture)

    expect(view).toEqual({
      purpose: 'member-reset-redemption',
      expectedEpoch: epoch,
      installationState: 'claimed',
      commandEnteredAt,
      codeIdentity,
      targetUserId: 'member-user',
      targetState: 'member',
      targetCredential: 'present',
      activeVerification: { id: 'member-verification', expiresAt },
    })
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]?.[1]).toEqual([normalizedMemberEmail])
    expect(query.mock.calls[0]?.[0]).toContain('lower(candidate.email) = $1')
    expect(query.mock.calls[0]?.[0]).toContain('COLLATE "C"')
    expect(query.mock.calls[0]?.[0]).toContain('LIMIT 2')
    expect(query.mock.calls[0]?.[0]).not.toMatch(/access_token|refresh_token|id_token/)
    expect(JSON.stringify(capture)).toBe('{}')
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain(normalizedMemberEmail)
    expect(serialized).not.toContain('private-password')
    expect(serialized).not.toContain('private-verification')
  })

  it('captures browser, CLI, and issuance owner purposes without crossing host identity', async () => {
    const web = querySequence(ownerRow())
    const cli = querySequence(ownerRow())
    const issue = querySequence(ownerRow())

    const webCapture = await captureOwnerWeb(web.surface)
    const cliCapture = await captureOwnerCli(cli.surface)
    const issueCapture = await captureOwnerIssue(issue.surface)

    expect(ownerRecoveryWebRedemptionCaptureView(webCapture)).toEqual({
      purpose: 'owner-recovery-web-redemption',
      expectedEpoch: epoch,
      installationState: 'claimed',
      commandEnteredAt,
      codeIdentity,
      ownerUserId: 'owner-user',
      ownerEmailMatches: true,
      ownerCredential: 'present',
      activeVerification: { id: 'owner-verification', expiresAt },
      hostInvocationId: null,
    })
    expect(ownerRecoveryCliRedemptionCaptureView(cliCapture)).toEqual({
      purpose: 'owner-recovery-cli-redemption',
      expectedEpoch: epoch,
      installationState: 'claimed',
      commandEnteredAt,
      codeIdentity,
      ownerUserId: 'owner-user',
      ownerEmailMatches: true,
      ownerCredential: 'present',
      activeVerification: { id: 'owner-verification', expiresAt },
      hostInvocationId: 'host-invocation-cli',
    })
    expect(ownerRecoveryIssuanceCaptureView(issueCapture)).toEqual({
      purpose: 'owner-recovery-issue',
      expectedEpoch: epoch,
      installationState: 'claimed',
      commandEnteredAt,
      ownerUserId: 'owner-user',
      ownerEmailMatches: true,
      ownerCredential: 'present',
      activeVerification: { id: 'owner-verification', expiresAt },
      hostInvocationId: 'host-invocation-issue',
    })
    expect(JSON.stringify(webCapture)).toBe('{}')
    expect(JSON.stringify(cliCapture)).toBe('{}')
    expect(JSON.stringify(issueCapture)).toBe('{}')
    expect(web.query.mock.calls[0]?.[1]).toEqual([normalizedOwnerEmail])
    expect(cli.query.mock.calls[0]?.[1]).toEqual([null])
    expect(issue.query.mock.calls[0]?.[1]).toEqual([null])
    expect(
      JSON.stringify(ownerRecoveryWebRedemptionCaptureView(webCapture)),
    ).not.toContain(normalizedOwnerEmail)
  })

  it('accepts the coherent open-installation owner shape for every owner flow', async () => {
    const web = querySequence(openOwnerRow())
    const cli = querySequence(openOwnerRow())
    const issue = querySequence(openOwnerRow())

    const webView = ownerRecoveryWebRedemptionCaptureView(
      await captureOwnerWeb(web.surface),
    )
    const cliView = ownerRecoveryCliRedemptionCaptureView(
      await captureOwnerCli(cli.surface),
    )
    const issueView = ownerRecoveryIssuanceCaptureView(
      await captureOwnerIssue(issue.surface),
    )

    expect(webView).toMatchObject({
      installationState: 'open',
      ownerUserId: null,
      ownerEmailMatches: false,
      ownerCredential: 'missing',
      activeVerification: null,
    })
    expect(cliView).toMatchObject({
      installationState: 'open',
      ownerUserId: null,
      ownerEmailMatches: false,
      ownerCredential: 'missing',
      activeVerification: null,
    })
    expect(issueView).toMatchObject({
      installationState: 'open',
      ownerUserId: null,
      ownerEmailMatches: false,
      ownerCredential: 'missing',
      activeVerification: null,
    })
  })

  it('resolves invalid-email synthetically and never accepts a database match for it', async () => {
    const absent = querySequence(
      memberRow({ users: [], credentials: [], states: [], verifications: [] }),
    )
    const absentCapture = await captureMember(absent.surface, {
      normalizedEmail: 'invalid-email',
    })

    expect(memberResetRedemptionCaptureView(absentCapture)).toMatchObject({
      targetUserId: null,
      targetState: 'missing',
      targetCredential: 'missing',
      activeVerification: null,
    })
    expect(absent.query.mock.calls[0]?.[1]).toEqual(['invalid-email'])

    const impossibleMatch = querySequence(
      memberRow({
        users: [user('member-user', 'invalid-email')],
        credentials: [credential('member-user')],
        states: [],
        verifications: [],
      }),
    )
    await expect(
      captureMember(impossibleMatch.surface, { normalizedEmail: 'invalid-email' }),
    ).rejects.toBeInstanceOf(RecoveryMutationCaptureInvariantError)

    const owner = querySequence(ownerRow({ submittedEmailUserIds: [] }))
    const ownerCapture = await captureOwnerWeb(owner.surface, {
      normalizedEmail: 'invalid-email',
    })
    expect(ownerRecoveryWebRedemptionCaptureView(ownerCapture).ownerEmailMatches).toBe(
      false,
    )
  })

  it('parses JSON timestamp strings into defensive Date values', async () => {
    const member = querySequence(memberRow({ datesAsStrings: true }))
    const owner = querySequence(ownerRow({ datesAsStrings: true }))

    const memberCapture = await captureMember(member.surface)
    const ownerCapture = await captureOwnerWeb(owner.surface)
    const firstMemberView = memberResetRedemptionCaptureView(memberCapture)
    const firstOwnerView = ownerRecoveryWebRedemptionCaptureView(ownerCapture)

    expect(firstMemberView.activeVerification?.expiresAt).toEqual(expiresAt)
    expect(firstOwnerView.activeVerification?.expiresAt).toEqual(expiresAt)
    firstMemberView.activeVerification?.expiresAt.setUTCFullYear(2099)
    firstOwnerView.activeVerification?.expiresAt.setUTCFullYear(2099)
    expect(
      memberResetRedemptionCaptureView(memberCapture).activeVerification?.expiresAt,
    ).toEqual(expiresAt)
    expect(
      ownerRecoveryWebRedemptionCaptureView(ownerCapture).activeVerification?.expiresAt,
    ).toEqual(expiresAt)
  })

  it('copies the caller-owned command clock before the capture query yields', async () => {
    const pending = deferredResult()
    const { surface } = querySequence(pending.promise)
    const enteredAt = new Date(commandEnteredAt)

    const capturePromise = captureMember(surface, { commandEnteredAt: enteredAt })
    enteredAt.setUTCFullYear(2099)
    pending.resolve(result(memberRow()))

    const capture = await capturePromise
    expect(capture).toBeInstanceOf(MemberResetRedemptionCapture)
    const view = memberResetRedemptionCaptureView(capture)
    expect(view.commandEnteredAt).toEqual(commandEnteredAt)
    view.commandEnteredAt.setUTCFullYear(2099)
    expect(memberResetRedemptionCaptureView(capture).commandEnteredAt).toEqual(
      commandEnteredAt,
    )
  })

  it('classifies an installed owner submitted to member redemption without granting member state', async () => {
    const row = memberRow({
      users: [user('owner-user', normalizedOwnerEmail)],
      credentials: [credential('owner-user')],
      states: [],
      verifications: [],
    })
    const { surface } = querySequence(row)

    const capture = await captureMember(surface, {
      normalizedEmail: normalizedOwnerEmail,
    })

    expect(memberResetRedemptionCaptureView(capture)).toMatchObject({
      targetUserId: 'owner-user',
      targetState: 'owner',
      targetCredential: 'present',
      activeVerification: null,
    })
  })

  it('fails closed on case-fold ambiguity and duplicate credential sets', async () => {
    const ambiguous = querySequence(
      memberRow({
        users: [
          user('member-a', 'Member@Example.Test'),
          user('member-b', normalizedMemberEmail),
        ],
        credentials: [],
        states: [],
        verifications: [],
      }),
    )
    await expect(captureMember(ambiguous.surface)).rejects.toBeInstanceOf(
      RecoveryMutationCaptureInvariantError,
    )

    const duplicateMemberCredential = querySequence(
      memberRow({
        credentials: [
          credential('member-user'),
          credential('member-user', { id: 'credential-member-user-2' }),
        ],
      }),
    )
    await expect(captureMember(duplicateMemberCredential.surface)).rejects.toBeInstanceOf(
      RecoveryMutationCaptureInvariantError,
    )

    const duplicateOwnerCredential = querySequence(
      ownerRow({
        credentials: [
          credential('owner-user'),
          credential('owner-user', { id: 'credential-owner-user-2' }),
        ],
      }),
    )
    await expect(
      captureOwnerIssue(duplicateOwnerCredential.surface),
    ).rejects.toBeInstanceOf(RecoveryMutationCaptureInvariantError)
  })

  it('binds browser owner recovery to the bounded submitted-email account set', async () => {
    const ambiguous = querySequence(
      ownerRow({ submittedEmailUserIds: ['owner-user', 'unrelated-user'] }),
    )
    await expect(captureOwnerWeb(ambiguous.surface)).rejects.toBeInstanceOf(
      RecoveryMutationCaptureInvariantError,
    )

    const changed = querySequence(
      ownerRow(),
      ownerRow({ submittedEmailUserIds: ['owner-user', 'unrelated-user'] }),
    )
    const capture = await captureOwnerWeb(changed.surface)
    await expect(
      recheckOwnerRecoveryWebRedemption(changed.surface, capture),
    ).resolves.toEqual({
      status: 'stale',
      reason: 'resolved-account-set-changed',
    })
  })

  it('fails closed on duplicate recovery verification sets', async () => {
    const duplicateMember = querySequence(
      memberRow({
        verifications: [
          verification('member-verification', 'indigo:member-reset:member-user'),
          verification('member-verification-2', 'indigo:member-reset:member-user'),
        ],
      }),
    )
    await expect(captureMember(duplicateMember.surface)).rejects.toBeInstanceOf(
      RecoveryMutationCaptureInvariantError,
    )

    const duplicateOwner = querySequence(
      ownerRow({
        verifications: [
          verification('owner-verification', 'indigo:owner-recovery:owner-user'),
          verification('owner-verification-2', 'indigo:owner-recovery:owner-user'),
        ],
      }),
    )
    await expect(captureOwnerWeb(duplicateOwner.surface)).rejects.toBeInstanceOf(
      RecoveryMutationCaptureInvariantError,
    )
  })

  it.each([
    ['missing active verification', [memberState()], []],
    [
      'unexpected verification without state',
      [],
      [verification('member-verification', 'indigo:member-reset:member-user')],
    ],
    [
      'unexpected verification for an inactive state',
      [memberState({ activeVerificationId: null })],
      [verification('member-verification', 'indigo:member-reset:member-user')],
    ],
    [
      'active-id mismatch',
      [memberState({ activeVerificationId: 'expected-verification' })],
      [verification('other-verification', 'indigo:member-reset:member-user')],
    ],
    [
      'active verification in the wrong namespace',
      [memberState()],
      [verification('member-verification', 'indigo:owner-recovery:member-user')],
    ],
  ] as const)('rejects member reset coherence failure: %s', async (_, states, verifications) => {
    const { surface } = querySequence(memberRow({ states, verifications }))

    await expect(captureMember(surface)).rejects.toBeInstanceOf(
      RecoveryMutationCaptureInvariantError,
    )
  })

  it('rejects reset state, credential, and verification rows outside the resolved member', async () => {
    const wrongCredential = querySequence(
      memberRow({ credentials: [credential('other-user')] }),
    )
    await expect(captureMember(wrongCredential.surface)).rejects.toBeInstanceOf(
      RecoveryMutationCaptureInvariantError,
    )

    const wrongState = querySequence(
      memberRow({ states: [memberState({ targetUserId: 'other-user' })] }),
    )
    await expect(captureMember(wrongState.surface)).rejects.toBeInstanceOf(
      RecoveryMutationCaptureInvariantError,
    )

    const unrelatedVerification = querySequence(
      memberRow({
        verifications: [
          verification('other-verification', 'indigo:member-reset:other-user'),
        ],
      }),
    )
    await expect(captureMember(unrelatedVerification.surface)).rejects.toBeInstanceOf(
      RecoveryMutationCaptureInvariantError,
    )
  })

  it('rejects incoherent open/claimed owner installation shapes', async () => {
    const openWithOwner = querySequence(
      ownerRow({ ownerUserId: null, bootstrapClosedAt: null }),
    )
    await expect(captureOwnerWeb(openWithOwner.surface)).rejects.toBeInstanceOf(
      RecoveryMutationCaptureInvariantError,
    )

    const claimedWithoutOwner = querySequence(
      ownerRow({ owners: [], credentials: [], verifications: [] }),
    )
    await expect(captureOwnerCli(claimedWithoutOwner.surface)).rejects.toBeInstanceOf(
      RecoveryMutationCaptureInvariantError,
    )

    const halfOpen = querySequence(
      ownerRow({
        ownerUserId: null,
        owners: [],
        credentials: [],
        verifications: [],
      }),
    )
    await expect(captureOwnerIssue(halfOpen.surface)).rejects.toBeInstanceOf(
      RecoveryMutationCaptureInvariantError,
    )
  })

  it.each([
    ['unnormalized email', { normalizedEmail: ' Owner@Example.Test ' }],
    ['empty email', { normalizedEmail: '' }],
    ['NUL email', { normalizedEmail: 'owner\0@example.test' }],
    ['uppercase code identity', { codeIdentity: 'A'.repeat(64) }],
    ['short code identity', { codeIdentity: 'a'.repeat(63) }],
    ['invalid command clock', { commandEnteredAt: new Date(Number.NaN) }],
  ] as const)('rejects invalid public redemption input: %s', async (_, overrides) => {
    const { query, surface } = querySequence(ownerRow())

    await expect(captureOwnerWeb(surface, overrides)).rejects.toBeInstanceOf(TypeError)
    expect(query).not.toHaveBeenCalled()
  })

  it.each([
    ['empty host identity', ''],
    ['NUL host identity', 'host\0invocation'],
    ['oversized host identity', 'h'.repeat(513)],
  ] as const)('rejects %s before a CLI or issuance query', async (_, hostInvocationId) => {
    const cli = querySequence(ownerRow())
    const issue = querySequence(ownerRow())

    await expect(
      captureOwnerCli(cli.surface, { hostInvocationId }),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      captureOwnerIssue(issue.surface, { hostInvocationId }),
    ).rejects.toBeInstanceOf(TypeError)
    expect(cli.query).not.toHaveBeenCalled()
    expect(issue.query).not.toHaveBeenCalled()
  })

  it('rejects malformed database scalar, private, date, and row cardinality shapes', async () => {
    const malformedEpoch = querySequence(memberRow({ epoch: 'not-an-epoch' }))
    await expect(captureMember(malformedEpoch.surface)).rejects.toBeInstanceOf(
      RecoveryMutationCaptureInvariantError,
    )

    const privateNul = querySequence(
      memberRow({
        credentials: [credential('member-user', { password: 'hash\0suffix' })],
      }),
    )
    await expect(captureMember(privateNul.surface)).rejects.toBeInstanceOf(
      RecoveryMutationCaptureInvariantError,
    )

    const invalidDate = querySequence(
      ownerRow({
        verifications: [
          verification('owner-verification', 'indigo:owner-recovery:owner-user', {
            expiresAt: 'not-a-date',
          }),
        ],
      }),
    )
    await expect(captureOwnerWeb(invalidDate.surface)).rejects.toBeInstanceOf(
      RecoveryMutationCaptureInvariantError,
    )

    const noRowsQuery = vi.fn().mockResolvedValue(resultRows([]))
    await expect(
      captureMember({ query: noRowsQuery } as unknown as IdentityRecoveryMutationQuery, {
        normalizedEmail: normalizedMemberEmail,
        codeIdentity,
        commandEnteredAt,
      }),
    ).rejects.toBeInstanceOf(RecoveryMutationCaptureInvariantError)

    const twoRowsQuery = vi.fn().mockResolvedValue(resultRows([memberRow(), memberRow()]))
    await expect(
      captureMember({ query: twoRowsQuery } as unknown as IdentityRecoveryMutationQuery),
    ).rejects.toBeInstanceOf(RecoveryMutationCaptureInvariantError)
  })

  it('validates PostgreSQL C byte order instead of JavaScript locale order', async () => {
    expect(Buffer.compare(Buffer.from('z'), Buffer.from('é'))).toBeLessThan(0)

    const byteUnorderedUsers = querySequence(
      memberRow({
        users: [
          user('é-user', normalizedMemberEmail),
          user('z-user', normalizedMemberEmail),
        ],
        credentials: [],
        states: [],
        verifications: [],
      }),
    )
    await expect(captureMember(byteUnorderedUsers.surface)).rejects.toBeInstanceOf(
      RecoveryMutationCaptureInvariantError,
    )

    const byteUnorderedVerifications = querySequence(
      ownerRow({
        verifications: [
          verification('é-verification', 'indigo:owner-recovery:owner-user'),
          verification('z-verification', 'indigo:owner-recovery:owner-user'),
        ],
      }),
    )
    await expect(
      captureOwnerIssue(byteUnorderedVerifications.surface),
    ).rejects.toBeInstanceOf(RecoveryMutationCaptureInvariantError)
  })

  it('keeps member rechecks independent of irrelevant owner rows', async () => {
    const first = memberRow({
      extra: {
        owner_user_rows: [user('owner-user', normalizedOwnerEmail)],
        owner_recovery_verification_rows: [
          verification('owner-verification', 'indigo:owner-recovery:owner-user'),
        ],
      },
    })
    const second = memberRow({
      extra: {
        owner_user_rows: [
          user('owner-user', 'changed-owner@example.test', { name: 'Changed Owner' }),
        ],
        owner_recovery_verification_rows: [],
      },
    })
    const { surface } = querySequence(first, second)
    const capture = await captureMember(surface)

    await expect(recheckMemberResetRedemption(surface, capture)).resolves.toEqual({
      status: 'current',
    })
  })

  it('keeps host recovery independent of any global submitted-email account set', async () => {
    const first = ownerRow({
      submittedEmailUserIds: ['owner-user', 'unrelated-user'],
    })
    const second = ownerRow({ submittedEmailUserIds: [] })
    const cli = querySequence(first, second)
    const issue = querySequence(first, second)

    const cliCapture = await captureOwnerCli(cli.surface)
    const issueCapture = await captureOwnerIssue(issue.surface)

    await expect(
      recheckOwnerRecoveryCliRedemption(cli.surface, cliCapture),
    ).resolves.toEqual({ status: 'current' })
    await expect(
      recheckOwnerRecoveryIssuance(issue.surface, issueCapture),
    ).resolves.toEqual({ status: 'current' })
    expect(cli.query.mock.calls[0]?.[1]).toEqual([null])
    expect(cli.query.mock.calls[1]?.[1]).toEqual([null])
    expect(issue.query.mock.calls[0]?.[1]).toEqual([null])
    expect(issue.query.mock.calls[1]?.[1]).toEqual([null])
  })

  it.each([
    ['epoch', memberRow({ epoch: nextEpoch }), 'installation-epoch-changed'],
    [
      'authority',
      memberRow({ bootstrapClosedAt: new Date('2026-02-02T00:00:00.000Z') }),
      'installation-authority-changed',
    ],
    [
      'resolved account',
      memberRow({
        users: [user('member-user', normalizedMemberEmail, { name: 'Renamed Trainee' })],
      }),
      'resolved-account-set-changed',
    ],
    [
      'credential',
      memberRow({
        credentials: [credential('member-user', { password: 'replacement-hash' })],
      }),
      'credential-set-changed',
    ],
    [
      'reset state',
      memberRow({ states: [memberState({ failedAttempts: 1 })] }),
      'member-reset-state-changed',
    ],
    [
      'verification',
      memberRow({
        verifications: [
          verification('member-verification', 'indigo:member-reset:member-user', {
            value: 'replacement-verification-value',
          }),
        ],
      }),
      'member-reset-verification-set-changed',
    ],
  ] as const)('returns the exact member stale reason for changed %s', async (_, changed, reason) => {
    const { surface } = querySequence(memberRow(), changed)
    const capture = await captureMember(surface)

    await expect(recheckMemberResetRedemption(surface, capture)).resolves.toEqual({
      status: 'stale',
      reason,
    })
  })

  it.each([
    [
      'epoch before every later dimension',
      memberRow({
        epoch: nextEpoch,
        bootstrapClosedAt: new Date('2026-02-02T00:00:00.000Z'),
        users: [user('member-user', normalizedMemberEmail, { name: 'Renamed Trainee' })],
        credentials: [credential('member-user', { password: 'replacement-hash' })],
        states: [memberState({ failedAttempts: 1 })],
        verifications: [
          verification('member-verification', 'indigo:member-reset:member-user', {
            value: 'replacement-verification-value',
          }),
        ],
      }),
      'installation-epoch-changed',
    ],
    [
      'authority before account, credential, reset, and verification',
      memberRow({
        bootstrapClosedAt: new Date('2026-02-02T00:00:00.000Z'),
        users: [user('member-user', normalizedMemberEmail, { name: 'Renamed Trainee' })],
        credentials: [credential('member-user', { password: 'replacement-hash' })],
        states: [memberState({ failedAttempts: 1 })],
        verifications: [
          verification('member-verification', 'indigo:member-reset:member-user', {
            value: 'replacement-verification-value',
          }),
        ],
      }),
      'installation-authority-changed',
    ],
    [
      'account before credential, reset, and verification',
      memberRow({
        users: [user('member-user', normalizedMemberEmail, { name: 'Renamed Trainee' })],
        credentials: [credential('member-user', { password: 'replacement-hash' })],
        states: [memberState({ failedAttempts: 1 })],
        verifications: [
          verification('member-verification', 'indigo:member-reset:member-user', {
            value: 'replacement-verification-value',
          }),
        ],
      }),
      'resolved-account-set-changed',
    ],
    [
      'credential before reset and verification',
      memberRow({
        credentials: [credential('member-user', { password: 'replacement-hash' })],
        states: [memberState({ failedAttempts: 1 })],
        verifications: [
          verification('member-verification', 'indigo:member-reset:member-user', {
            value: 'replacement-verification-value',
          }),
        ],
      }),
      'credential-set-changed',
    ],
    [
      'reset before verification',
      memberRow({
        states: [memberState({ failedAttempts: 1 })],
        verifications: [
          verification('member-verification', 'indigo:member-reset:member-user', {
            value: 'replacement-verification-value',
          }),
        ],
      }),
      'member-reset-state-changed',
    ],
  ] as const)('uses stale-reason precedence: %s', async (_, changed, reason) => {
    const { surface } = querySequence(memberRow(), changed)
    const capture = await captureMember(surface)

    await expect(recheckMemberResetRedemption(surface, capture)).resolves.toEqual({
      status: 'stale',
      reason,
    })
  })

  it.each([
    ['epoch', ownerRow({ epoch: nextEpoch }), 'installation-epoch-changed'],
    [
      'authority',
      ownerRow({ bootstrapClosedAt: new Date('2026-02-02T00:00:00.000Z') }),
      'installation-authority-changed',
    ],
    [
      'owner row',
      ownerRow({
        owners: [user('owner-user', normalizedOwnerEmail, { name: 'Renamed Owner' })],
      }),
      'owner-state-changed',
    ],
    [
      'credential',
      ownerRow({
        credentials: [credential('owner-user', { password: 'replacement-hash' })],
      }),
      'credential-set-changed',
    ],
    [
      'verification',
      ownerRow({
        verifications: [
          verification('owner-verification', 'indigo:owner-recovery:owner-user', {
            value: 'replacement-verification-value',
          }),
        ],
      }),
      'owner-recovery-state-changed',
    ],
  ] as const)('returns the exact owner stale reason for changed %s', async (_, changed, reason) => {
    const { surface } = querySequence(ownerRow(), changed)
    const capture = await captureOwnerWeb(surface)

    await expect(recheckOwnerRecoveryWebRedemption(surface, capture)).resolves.toEqual({
      status: 'stale',
      reason,
    })
  })

  it.each([
    ['createdAt', { createdAt: new Date('2026-01-01T00:00:00.001Z') }],
    ['updatedAt', { updatedAt: new Date('2026-06-01T00:00:00.001Z') }],
  ] as const)('independently rechecks the owner %s timestamp', async (_, changed) => {
    const { surface } = querySequence(
      ownerRow(),
      ownerRow({
        owners: [user('owner-user', normalizedOwnerEmail, changed)],
      }),
    )
    const capture = await captureOwnerWeb(surface)

    await expect(recheckOwnerRecoveryWebRedemption(surface, capture)).resolves.toEqual({
      status: 'stale',
      reason: 'owner-state-changed',
    })
  })

  it.each([
    [
      'epoch before every later dimension',
      ownerRow({
        epoch: nextEpoch,
        bootstrapClosedAt: new Date('2026-02-02T00:00:00.000Z'),
        owners: [user('owner-user', normalizedOwnerEmail, { name: 'Renamed Owner' })],
        credentials: [credential('owner-user', { password: 'replacement-hash' })],
        verifications: [
          verification('owner-verification', 'indigo:owner-recovery:owner-user', {
            value: 'replacement-verification-value',
          }),
        ],
      }),
      'installation-epoch-changed',
    ],
    [
      'authority before owner, credential, and recovery state',
      ownerRow({
        bootstrapClosedAt: new Date('2026-02-02T00:00:00.000Z'),
        owners: [user('owner-user', normalizedOwnerEmail, { name: 'Renamed Owner' })],
        credentials: [credential('owner-user', { password: 'replacement-hash' })],
        verifications: [
          verification('owner-verification', 'indigo:owner-recovery:owner-user', {
            value: 'replacement-verification-value',
          }),
        ],
      }),
      'installation-authority-changed',
    ],
    [
      'owner before credential and recovery state',
      ownerRow({
        owners: [user('owner-user', normalizedOwnerEmail, { name: 'Renamed Owner' })],
        credentials: [credential('owner-user', { password: 'replacement-hash' })],
        verifications: [
          verification('owner-verification', 'indigo:owner-recovery:owner-user', {
            value: 'replacement-verification-value',
          }),
        ],
      }),
      'owner-state-changed',
    ],
    [
      'credential before recovery state',
      ownerRow({
        credentials: [credential('owner-user', { password: 'replacement-hash' })],
        verifications: [
          verification('owner-verification', 'indigo:owner-recovery:owner-user', {
            value: 'replacement-verification-value',
          }),
        ],
      }),
      'credential-set-changed',
    ],
  ] as const)('uses owner stale-reason precedence: %s', async (_, changed, reason) => {
    const { surface } = querySequence(ownerRow(), changed)
    const capture = await captureOwnerWeb(surface)

    await expect(recheckOwnerRecoveryWebRedemption(surface, capture)).resolves.toEqual({
      status: 'stale',
      reason,
    })
  })

  it('rejects forged captures for every view and recheck API', async () => {
    const surface = querySequence(memberRow()).surface
    const forgedMember = Object.create(
      MemberResetRedemptionCapture.prototype,
    ) as MemberResetRedemptionCapture
    const forgedWeb = Object.create(
      OwnerRecoveryWebRedemptionCapture.prototype,
    ) as OwnerRecoveryWebRedemptionCapture
    const forgedCli = Object.create(
      OwnerRecoveryCliRedemptionCapture.prototype,
    ) as OwnerRecoveryCliRedemptionCapture
    const forgedIssue = Object.create(
      OwnerRecoveryIssuanceCapture.prototype,
    ) as OwnerRecoveryIssuanceCapture

    expect(() => memberResetRedemptionCaptureView(forgedMember)).toThrow(
      'was not issued or is no longer fresh',
    )
    expect(() => ownerRecoveryWebRedemptionCaptureView(forgedWeb)).toThrow(
      'was not issued or is no longer fresh',
    )
    expect(() => ownerRecoveryCliRedemptionCaptureView(forgedCli)).toThrow(
      'was not issued or is no longer fresh',
    )
    expect(() => ownerRecoveryIssuanceCaptureView(forgedIssue)).toThrow(
      'was not issued or is no longer fresh',
    )
    await expect(recheckMemberResetRedemption(surface, forgedMember)).rejects.toThrow(
      'was not issued or is no longer fresh',
    )
    await expect(recheckOwnerRecoveryWebRedemption(surface, forgedWeb)).rejects.toThrow(
      'was not issued or is no longer fresh',
    )
    await expect(recheckOwnerRecoveryCliRedemption(surface, forgedCli)).rejects.toThrow(
      'was not issued or is no longer fresh',
    )
    await expect(recheckOwnerRecoveryIssuance(surface, forgedIssue)).rejects.toThrow(
      'was not issued or is no longer fresh',
    )
  })

  it('claims a member capture synchronously and rejects concurrent and second use', async () => {
    const pending = deferredResult()
    const { surface } = querySequence(memberRow(), pending.promise)
    const capture = await captureMember(surface)

    const first = recheckMemberResetRedemption(surface, capture)
    await expect(recheckMemberResetRedemption(surface, capture)).rejects.toThrow(
      'no longer fresh',
    )
    expect(() => memberResetRedemptionCaptureView(capture)).toThrow('no longer fresh')
    pending.resolve(result(memberRow()))
    await expect(first).resolves.toEqual({ status: 'current' })
    await expect(recheckMemberResetRedemption(surface, capture)).rejects.toThrow(
      'no longer fresh',
    )
  })

  it('claims all owner captures synchronously and rejects concurrent or second use', async () => {
    const webPending = deferredResult()
    const cliPending = deferredResult()
    const issuePending = deferredResult()
    const web = querySequence(ownerRow(), webPending.promise)
    const cli = querySequence(ownerRow(), cliPending.promise)
    const issue = querySequence(ownerRow(), issuePending.promise)
    const webCapture = await captureOwnerWeb(web.surface)
    const cliCapture = await captureOwnerCli(cli.surface)
    const issueCapture = await captureOwnerIssue(issue.surface)

    const webFirst = recheckOwnerRecoveryWebRedemption(web.surface, webCapture)
    const cliFirst = recheckOwnerRecoveryCliRedemption(cli.surface, cliCapture)
    const issueFirst = recheckOwnerRecoveryIssuance(issue.surface, issueCapture)

    await expect(
      recheckOwnerRecoveryWebRedemption(web.surface, webCapture),
    ).rejects.toThrow('no longer fresh')
    await expect(
      recheckOwnerRecoveryCliRedemption(cli.surface, cliCapture),
    ).rejects.toThrow('no longer fresh')
    await expect(
      recheckOwnerRecoveryIssuance(issue.surface, issueCapture),
    ).rejects.toThrow('no longer fresh')
    webPending.resolve(result(ownerRow()))
    cliPending.resolve(result(ownerRow()))
    issuePending.resolve(result(ownerRow()))
    await expect(webFirst).resolves.toEqual({ status: 'current' })
    await expect(cliFirst).resolves.toEqual({ status: 'current' })
    await expect(issueFirst).resolves.toEqual({ status: 'current' })
    expect(() => ownerRecoveryWebRedemptionCaptureView(webCapture)).toThrow(
      'no longer fresh',
    )
    expect(() => ownerRecoveryCliRedemptionCaptureView(cliCapture)).toThrow(
      'no longer fresh',
    )
    expect(() => ownerRecoveryIssuanceCaptureView(issueCapture)).toThrow(
      'no longer fresh',
    )
  })

  it('spends a capture when its recheck query fails', async () => {
    const member = querySequence(memberRow(), new Error('database unavailable'))
    const owner = querySequence(ownerRow(), new Error('database unavailable'))
    const memberCapture = await captureMember(member.surface)
    const ownerCapture = await captureOwnerIssue(owner.surface)

    await expect(
      recheckMemberResetRedemption(member.surface, memberCapture),
    ).rejects.toThrow('database unavailable')
    await expect(
      recheckOwnerRecoveryIssuance(owner.surface, ownerCapture),
    ).rejects.toThrow('database unavailable')
    expect(() => memberResetRedemptionCaptureView(memberCapture)).toThrow(
      'no longer fresh',
    )
    expect(() => ownerRecoveryIssuanceCaptureView(ownerCapture)).toThrow(
      'no longer fresh',
    )
    await expect(
      recheckMemberResetRedemption(member.surface, memberCapture),
    ).rejects.toThrow('no longer fresh')
    await expect(
      recheckOwnerRecoveryIssuance(owner.surface, ownerCapture),
    ).rejects.toThrow('no longer fresh')
  })

  it('spends stale captures and does not issue another query on reuse', async () => {
    const { query, surface } = querySequence(memberRow(), memberRow({ epoch: nextEpoch }))
    const capture = await captureMember(surface)

    await expect(recheckMemberResetRedemption(surface, capture)).resolves.toEqual({
      status: 'stale',
      reason: 'installation-epoch-changed',
    })
    await expect(recheckMemberResetRedemption(surface, capture)).rejects.toThrow(
      'no longer fresh',
    )
    expect(query).toHaveBeenCalledTimes(2)
  })
})
