import { describe, expect, it, vi } from 'vitest'
import {
  captureSubjectExportAuthority,
  IdentitySubjectExportAuthorityUnavailableError,
  IdentitySubjectExportCommandError,
  IdentitySubjectExportInvariantError,
  issueSubjectExportCommand,
  recheckSubjectExportAuthority,
  type SubjectExportCommand,
  subjectExportAuthorityView,
} from './subject-export-authority'

const epoch = '123e4567-e89b-42d3-a456-426614174000'
const now = new Date('2026-07-16T12:00:00.000Z')

function snapshot(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    product_mutation_epoch: epoch,
    installation_owner_user_id: 'owner-1',
    bootstrap_closed_at: new Date('2026-07-01T00:00:00.000Z'),
    session_rows: [
      {
        id: 'session-1',
        userId: 'owner-1',
        expiresAt: new Date('2026-07-17T00:00:00.000Z'),
        createdAt: new Date('2026-07-15T00:00:00.000Z'),
        updatedAt: new Date('2026-07-15T00:00:00.000Z'),
        active: true,
      },
    ],
    actor_rows: [
      {
        id: 'owner-1',
        name: 'Owner',
        email: 'owner@example.test',
        emailVerified: true,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    ],
    ...overrides,
  }
}

function queryWith(...rows: readonly (Readonly<Record<string, unknown>> | null)[]) {
  const query = vi.fn()
  for (const row of rows) {
    query.mockResolvedValueOnce({ rows: row === null ? [] : [row] })
  }
  return { query }
}

describe('subject export Identity authority', () => {
  it('keeps verified token material nominal, non-serializable, and out of its view', async () => {
    const command = issueSubjectExportCommand({
      verifiedSessionToken: 'private-session-token',
    })
    const database = queryWith(snapshot())
    const capture = await captureSubjectExportAuthority(database, command)
    const view = subjectExportAuthorityView(capture)

    expect(Object.keys(command)).toEqual([])
    expect(JSON.stringify(command)).not.toContain('private-session-token')
    expect(view).toEqual({
      expectedEpoch: epoch,
      sessionId: 'session-1',
      sessionExpiresAt: new Date('2026-07-17T00:00:00.000Z'),
      actorUserId: 'owner-1',
      expectedRole: 'owner',
      installationOwnerUserId: 'owner-1',
      installationState: 'claimed',
    })
    expect(JSON.stringify(view)).not.toContain('private-session-token')
    expect(database.query).toHaveBeenCalledTimes(1)
    const [statement, values] = database.query.mock.calls[0] ?? []
    expect(statement).toContain('FROM installation_state')
    expect(statement).toContain('FROM "session"')
    expect(statement).not.toContain('account')
    expect(statement).not.toContain('password')
    expect(values).toEqual(['private-session-token'])
  })

  it('rejects forged commands before issuing a database query', async () => {
    const database = queryWith(snapshot())
    await expect(
      captureSubjectExportAuthority(database, {} as SubjectExportCommand),
    ).rejects.toBeInstanceOf(IdentitySubjectExportCommandError)
    expect(database.query).not.toHaveBeenCalled()
  })

  it.each([
    ['missing installation', null],
    ['missing session', snapshot({ session_rows: [] })],
    [
      'expired session',
      snapshot({
        session_rows: [
          {
            id: 'session-1',
            userId: 'owner-1',
            expiresAt: now,
            createdAt: now,
            updatedAt: now,
            active: false,
          },
        ],
      }),
    ],
  ])('fails unavailable for %s during capture', async (_label, row) => {
    const command = issueSubjectExportCommand({ verifiedSessionToken: 'token' })
    await expect(
      captureSubjectExportAuthority(queryWith(row), command),
    ).rejects.toBeInstanceOf(IdentitySubjectExportAuthorityUnavailableError)
  })

  it.each([
    ['duplicate session', snapshot({ session_rows: [{}, {}] })],
    ['duplicate actor', snapshot({ actor_rows: [{}, {}] })],
    ['invalid epoch', snapshot({ product_mutation_epoch: 'not-an-epoch' })],
    ['session/actor mismatch', snapshot({ actor_rows: [{ id: 'actor-2' }] })],
  ])('fails closed for malformed %s shape', async (_label, row) => {
    const command = issueSubjectExportCommand({ verifiedSessionToken: 'token' })
    await expect(
      captureSubjectExportAuthority(queryWith(row), command),
    ).rejects.toBeInstanceOf(IdentitySubjectExportInvariantError)
  })

  it.each([
    [
      'installation-epoch-changed',
      snapshot({
        product_mutation_epoch: '223e4567-e89b-42d3-a456-426614174000',
      }),
    ],
    [
      'installation-authority-changed',
      snapshot({ installation_owner_user_id: 'owner-2' }),
    ],
    ['session-changed', snapshot({ session_rows: [] })],
    [
      'actor-changed',
      snapshot({
        actor_rows: [
          {
            id: 'owner-1',
            name: 'Renamed Owner',
            email: 'owner@example.test',
            emailVerified: true,
            createdAt: new Date('2026-07-01T00:00:00.000Z'),
            updatedAt: new Date('2026-07-16T00:00:00.000Z'),
          },
        ],
      }),
    ],
  ])('reports %s on transactional drift', async (reason, current) => {
    const command = issueSubjectExportCommand({ verifiedSessionToken: 'token' })
    const database = queryWith(snapshot(), current)
    const capture = await captureSubjectExportAuthority(database, command)

    await expect(recheckSubjectExportAuthority(database, capture)).resolves.toEqual({
      status: 'stale',
      reason,
    })
    expect(database.query).toHaveBeenCalledTimes(2)
  })

  it('accepts one byte-equal transactional authority recheck', async () => {
    const command = issueSubjectExportCommand({ verifiedSessionToken: 'token' })
    const database = queryWith(snapshot(), snapshot())
    const capture = await captureSubjectExportAuthority(database, command)

    await expect(recheckSubjectExportAuthority(database, capture)).resolves.toEqual({
      status: 'current',
    })
  })
})
