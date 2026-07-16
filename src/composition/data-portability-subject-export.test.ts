import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CoordinationError } from '@/application/coordination'
import {
  getProductionDataPortabilitySubjectExportPort,
  type SubjectExportResult,
} from './data-portability-subject-export'

const mocks = vi.hoisted(() => {
  class AuthorityUnavailableError extends Error {}
  class CommandError extends Error {}
  class IdentityInvariantError extends Error {}
  class GraphInvariantError extends Error {}
  class CapacityError extends Error {}
  class DataExportError extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  }
  return {
    AuthorityUnavailableError,
    CommandError,
    IdentityInvariantError,
    GraphInvariantError,
    CapacityError,
    DataExportError,
    capture: vi.fn(),
    captureView: vi.fn(),
    recheck: vi.fn(),
    withTrustedCapture: vi.fn(),
    createRuntime: vi.fn(),
    createScopedDatabase: vi.fn(),
    createGateway: vi.fn(),
    gatewayRead: vi.fn(),
    finalize: vi.fn(),
    events: [] as string[],
    runError: null as unknown,
    capturedAuthorityOverride: null as Record<string, unknown> | null,
    lastRequest: null as Record<string, unknown> | null,
    trustedOptions: null as Record<string, unknown> | null,
  }
})

vi.mock('@/modules/identity/infrastructure/subject-export-authority', () => ({
  captureSubjectExportAuthority: mocks.capture,
  subjectExportAuthorityView: mocks.captureView,
  recheckSubjectExportAuthority: mocks.recheck,
  IdentitySubjectExportAuthorityUnavailableError: mocks.AuthorityUnavailableError,
  IdentitySubjectExportCommandError: mocks.CommandError,
  IdentitySubjectExportInvariantError: mocks.IdentityInvariantError,
}))
vi.mock('@/modules/data-portability/infrastructure/scoped-subject-export', () => ({
  createScopedSubjectExportGateway: mocks.createGateway,
  SubjectExportGraphInvariantError: mocks.GraphInvariantError,
}))
vi.mock('@/modules/data-portability/application/export', () => ({
  DataExportError: mocks.DataExportError,
  finalizeDataExport: mocks.finalize,
}))
vi.mock('@/platform/db/credential-connections', () => ({
  CredentialConnectionCapacityError: mocks.CapacityError,
  withTrustedCredentialCapture: mocks.withTrustedCapture,
}))
vi.mock('@/platform/application-coordination/lifecycle-values', () => ({
  createInstallationMutationEpoch: (value: string) => ({ value }),
  installationMutationEpochMatches: (candidate: { value?: string }, expected: string) =>
    candidate.value === expected,
}))
vi.mock('@/platform/application-coordination/mutation-authority', () => ({
  createPlatformMutationAuthorityIssuer: () => ({
    authenticatedSession: (input: {
      expectedEpoch: object
      actorUserId: string
      sessionId: string
      expectedRole: string
    }) => ({
      expectedEpoch: input.expectedEpoch,
      authority: {
        kind: 'authenticated-session',
        actorUserId: input.actorUserId,
        expectedRole: input.expectedRole,
        session: {},
      },
    }),
  }),
}))
vi.mock('@/platform/application-coordination/scoped-drizzle', () => ({
  createScopedDrizzleDatabase: mocks.createScopedDatabase,
}))
vi.mock('@/platform/application-coordination/runtime-unit-of-work', () => ({
  createRuntimePostgresUnitOfWork: mocks.createRuntime,
}))

const view = Object.freeze({
  expectedEpoch: '123e4567-e89b-42d3-a456-426614174000',
  sessionId: 'session-1',
  sessionExpiresAt: new Date('2026-07-17T00:00:00.000Z'),
  actorUserId: 'actor-1',
  expectedRole: 'member' as const,
  installationOwnerUserId: 'owner-1',
  installationState: 'claimed' as const,
})
const command = Object.freeze({}) as never
const capture = Object.freeze({})
const files = Object.freeze({ identity: { id: 'actor-1' }, sessions: [] })
const archive = Object.freeze({ manifest: { subjectUserId: 'actor-1' }, ...files })

describe('Data Portability subject export composition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.events.length = 0
    mocks.runError = null
    mocks.capturedAuthorityOverride = null
    mocks.lastRequest = null
    mocks.trustedOptions = null
    mocks.capture.mockImplementation(async () => {
      mocks.events.push('capture')
      return capture
    })
    mocks.captureView.mockReturnValue(view)
    mocks.recheck.mockImplementation(async () => {
      mocks.events.push('identity-recheck')
      return { status: 'current' }
    })
    mocks.gatewayRead.mockImplementation(async () => {
      mocks.events.push('export-read')
      return files
    })
    mocks.createGateway.mockReturnValue({ readFiles: mocks.gatewayRead })
    mocks.createScopedDatabase.mockReturnValue({ scoped: true })
    mocks.finalize.mockImplementation(() => {
      mocks.events.push('finalize')
      return archive
    })
    mocks.withTrustedCapture.mockImplementation(async (callback, options) => {
      mocks.trustedOptions = options
      return callback({ query: vi.fn() })
    })
    mocks.createRuntime.mockImplementation((factory) => ({
      run: async (
        request: Record<string, unknown>,
        callback: (scope: {
          gateways: { subjectExport: { readFiles: () => Promise<typeof files> } }
          content: { kind: 'none' }
        }) => Promise<unknown>,
      ) => {
        mocks.lastRequest = request
        if (mocks.runError) throw mocks.runError
        const capturedAuthority =
          mocks.capturedAuthorityOverride ??
          ({
            kind: 'authenticated-session',
            expectedEpoch: request.expectedEpoch,
            actorUserId: 'actor-1',
            sessionId: 'session-1',
            expectedRole: 'member',
          } as const)
        const context = factory({
          client: { query: vi.fn() },
          request,
          capturedAuthority,
        })
        await context.recheckIdentity()
        return callback({ gateways: context.readGateways, content: { kind: 'none' } })
      },
    }))
  })

  it('captures before admission, rechecks first, and finalizes only after the UoW returns', async () => {
    const signal = new AbortController().signal
    const result = await getProductionDataPortabilitySubjectExportPort().create(command, {
      signal,
    })

    expect(result).toEqual({ kind: 'exported', archive })
    expect(mocks.events).toEqual([
      'capture',
      'identity-recheck',
      'export-read',
      'finalize',
    ])
    expect(mocks.trustedOptions).toEqual({ signal })
    expect(mocks.lastRequest).toMatchObject({
      operation: 'subject-export',
      session: { kind: 'ordinary' },
      productFence: 'shared',
      subjectLock: { subjectUserId: 'actor-1', mode: 'shared' },
      content: { kind: 'none' },
      mode: { isolation: 'repeatable-read', access: 'read-only' },
      signal,
    })
    expect(mocks.createGateway).toHaveBeenCalledWith(
      { scoped: true },
      { subjectUserId: 'actor-1' },
    )
    expect(mocks.finalize).toHaveBeenCalledWith('actor-1', files)
  })

  it('rejects captured-authority drift before the export gateway is invoked', async () => {
    mocks.capturedAuthorityOverride = {
      kind: 'authenticated-session',
      expectedEpoch: { value: view.expectedEpoch },
      actorUserId: 'actor-2',
      sessionId: view.sessionId,
      expectedRole: view.expectedRole,
    }

    await expect(
      getProductionDataPortabilitySubjectExportPort().create(command),
    ).resolves.toEqual({ kind: 'stale' })
    expect(mocks.gatewayRead).not.toHaveBeenCalled()
    expect(mocks.finalize).not.toHaveBeenCalled()
  })

  it('maps a stale transactional recheck without reading or finalizing', async () => {
    mocks.recheck.mockResolvedValue({
      status: 'stale',
      reason: 'session-changed',
    })

    await expect(
      getProductionDataPortabilitySubjectExportPort().create(command),
    ).resolves.toEqual({ kind: 'stale' })
    expect(mocks.gatewayRead).not.toHaveBeenCalled()
    expect(mocks.finalize).not.toHaveBeenCalled()
  })

  it.each([
    ['forged command', new mocks.CommandError(), { kind: 'stale' }],
    ['capture capacity', new mocks.CapacityError(), { kind: 'unavailable' }],
    ['invalid Identity shape', new mocks.IdentityInvariantError(), { kind: 'invalid' }],
  ] as const)('maps %s before UoW admission', async (_label, error, expected) => {
    mocks.capture.mockRejectedValue(error)

    await expect(
      getProductionDataPortabilitySubjectExportPort().create(command),
    ).resolves.toEqual(expected)
    expect(mocks.createRuntime).not.toHaveBeenCalled()
  })

  it.each([
    ['capacity', new CoordinationError('uow.capacity'), { kind: 'unavailable' }],
    [
      'commit uncertainty',
      new CoordinationError('uow.commit-outcome-unknown'),
      { kind: 'unavailable' },
    ],
    [
      'authority loss',
      new CoordinationError('identity.authority-stale'),
      { kind: 'stale' },
    ],
  ] as const)('maps %s without producing an archive', async (_label, error, expected) => {
    mocks.runError = error

    const result: SubjectExportResult =
      await getProductionDataPortabilitySubjectExportPort().create(command)
    expect(result).toEqual(expected)
    expect(mocks.gatewayRead).not.toHaveBeenCalled()
    expect(mocks.finalize).not.toHaveBeenCalled()
  })

  it('fails the whole archive on a subject-graph invariant', async () => {
    mocks.gatewayRead.mockRejectedValue(new mocks.GraphInvariantError())

    await expect(
      getProductionDataPortabilitySubjectExportPort().create(command),
    ).resolves.toEqual({ kind: 'invalid' })
    expect(mocks.finalize).not.toHaveBeenCalled()
  })
})
