import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CoordinationError } from '@/application/coordination'
import { DeletionError } from '@/modules/data-portability/application/deletion'
import {
  IdentityDestructiveMutationAuthorityUnavailableError,
  IdentityDestructiveMutationCaptureInvariantError,
} from '@/modules/identity/infrastructure/destructive-mutation'
import { CredentialConnectionCapacityError } from '@/platform/db/credential-connections'

type RecordedRequest = Readonly<{
  operation: string
  authority: Readonly<{
    purpose: string
    captured?: Record<string, unknown>
    protectedCaptured?: Record<string, unknown>
  }>
  session: Readonly<{ lease: object }>
  productFence: string
  subjectLock: unknown
  mode: Readonly<{ isolation: string; access: string }>
}>

const mocks = vi.hoisted(() => {
  const commandEnteredAt = new Date('2026-07-16T14:00:00.000Z')
  return {
    commandEnteredAt,
    events: [] as string[],
    requests: [] as RecordedRequest[],
    leases: [] as object[],
    capturedBindings: [] as Record<string, unknown>[],
    attemptInputs: [] as Record<string, unknown>[],
    trustedCaptureError: null as unknown,
    outerBeforeError: null as unknown,
    outerAfterError: null as unknown,
    attemptBeforeError: null as unknown,
    attemptAfterError: null as unknown,
    protectedBeforeError: null as unknown,
    protectedAfterError: null as unknown,
    protectedGatewayError: null as unknown,
    subjectActionBindingAccepted: true,
    resetActionBindingAccepted: true,
    subjectRecheck: { status: 'current' } as
      | { status: 'current' }
      | { status: 'stale'; reason: string },
    resetRecheck: { status: 'current' } as
      | { status: 'current' }
      | { status: 'stale'; reason: string },
    subjectAttemptStatus: 'succeeded' as 'succeeded' | 'failed' | 'locked',
    resetAttemptStatus: 'succeeded' as 'succeeded' | 'failed' | 'locked',
    subjectCommand: {
      purpose: 'trainee-data-deletion',
      actionBinding: 'subject-binding',
      planId: 'subject-plan',
      planDigest: 'subject-digest',
      currentPassword: 'member-password',
      typedConfirmation: 'DELETE',
      acknowledged: true,
      commandEnteredAt,
      requestContext: { channel: 'web', clientAddress: '127.0.0.1' },
    },
    resetCommand: {
      purpose: 'instance-reset',
      actionBinding: 'reset-binding',
      planId: 'reset-plan',
      planDigest: 'reset-digest',
      currentPassword: 'owner-password',
      typedConfirmation: 'RESET',
      acknowledged: true,
      commandEnteredAt,
      requestContext: { channel: 'web', clientAddress: '127.0.0.1' },
    },
    subjectView: {
      purpose: 'trainee-data-deletion',
      expectedEpoch: '11111111-1111-4111-8111-111111111111',
      sessionId: 'member-session',
      sessionExpiresAt: new Date('2026-07-16T16:00:00.000Z'),
      actorUserId: 'member-1',
      actorEmail: 'member@example.test',
      actorName: 'Member',
      expectedRole: 'member' as 'owner' | 'member',
      installationOwnerUserId: 'owner-1',
      installationState: 'claimed',
      actorCredential: 'present',
      planId: 'subject-plan',
      planDigest: 'subject-digest',
    },
    resetView: {
      purpose: 'instance-reset',
      expectedEpoch: '11111111-1111-4111-8111-111111111111',
      sessionId: 'owner-session',
      sessionExpiresAt: new Date('2026-07-16T16:00:00.000Z'),
      actorUserId: 'owner-1',
      actorEmail: 'owner@example.test',
      actorName: 'Owner',
      expectedRole: 'owner' as 'owner' | 'member',
      installationOwnerUserId: 'owner-1',
      installationState: 'claimed',
      actorCredential: 'present',
      planId: 'reset-plan',
      planDigest: 'reset-digest',
    },
    getDb: vi.fn(),
  }
})

vi.mock('@/modules/identity/server/destructive-command', () => ({
  traineeDataDeletionCommandView: vi.fn(() => mocks.subjectCommand),
  instanceResetCommandView: vi.fn(() => mocks.resetCommand),
}))

vi.mock('@/modules/identity/infrastructure/action-binding', () => ({
  verifyTraineeDataDeletionActionBinding: vi.fn((binding, context, now) => {
    mocks.events.push(`binding:subject:${binding}:${now.toISOString()}`)
    mocks.capturedBindings.push(context)
    return mocks.subjectActionBindingAccepted
  }),
  verifyInstanceResetActionBinding: vi.fn((binding, context, now) => {
    mocks.events.push(`binding:reset:${binding}:${now.toISOString()}`)
    mocks.capturedBindings.push(context)
    return mocks.resetActionBindingAccepted
  }),
}))

vi.mock('@/modules/identity/infrastructure/destructive-mutation', () => {
  class IdentityDestructiveMutationCaptureInvariantError extends Error {}
  class IdentityDestructiveMutationAuthorityUnavailableError extends Error {}
  class IdentityDestructiveMutationCaptureStaleError extends Error {}
  return {
    IdentityDestructiveMutationCaptureInvariantError,
    IdentityDestructiveMutationAuthorityUnavailableError,
    IdentityDestructiveMutationCaptureStaleError,
    captureTraineeDataDeletionMutation: vi.fn(async () => {
      mocks.events.push('identity:capture:subject')
      return { kind: 'subject-capture' }
    }),
    captureInstanceResetMutation: vi.fn(async () => {
      mocks.events.push('identity:capture:reset')
      return { kind: 'reset-capture' }
    }),
    traineeDataDeletionMutationCaptureView: vi.fn(() => mocks.subjectView),
    instanceResetMutationCaptureView: vi.fn(() => mocks.resetView),
    recheckTraineeDataDeletionMutation: vi.fn(async () => {
      mocks.events.push('identity:recheck:subject')
      return mocks.subjectRecheck
    }),
    recheckInstanceResetMutation: vi.fn(async () => {
      mocks.events.push('identity:recheck:reset')
      return mocks.resetRecheck
    }),
  }
})

vi.mock('@/modules/identity/infrastructure/scoped-credential-reauthentication', () => ({
  createScopedSubjectDeletionReauthenticationGateway: vi.fn(() => ({
    attempt: vi.fn(async (input) => {
      mocks.events.push('gateway:reauthenticate:subject')
      mocks.attemptInputs.push(input)
      if (
        mocks.subjectAttemptStatus === 'failed' ||
        mocks.subjectAttemptStatus === 'locked'
      ) {
        return { status: mocks.subjectAttemptStatus }
      }
      return { status: 'succeeded', authority: input.markReauthenticationSucceeded() }
    }),
  })),
  createScopedInstanceResetReauthenticationGateway: vi.fn(() => ({
    attempt: vi.fn(async (input) => {
      mocks.events.push('gateway:reauthenticate:reset')
      mocks.attemptInputs.push(input)
      if (
        mocks.resetAttemptStatus === 'failed' ||
        mocks.resetAttemptStatus === 'locked'
      ) {
        return { status: mocks.resetAttemptStatus }
      }
      return { status: 'succeeded', authority: input.markReauthenticationSucceeded() }
    }),
  })),
}))

vi.mock('@/modules/data-portability/infrastructure/scoped-destructive-adapter', () => ({
  createScopedSubjectDeletionAttemptGateway: vi.fn(() => ({
    invalidatePreviewAfterDenial: vi.fn(async () => {
      mocks.events.push('gateway:invalidate:subject')
    }),
  })),
  createScopedInstanceResetAttemptGateway: vi.fn(() => ({
    invalidatePreviewAfterDenial: vi.fn(async () => {
      mocks.events.push('gateway:invalidate:reset')
    }),
  })),
  createScopedSubjectDeletionGateway: vi.fn((_database, binding) => {
    mocks.capturedBindings.push(binding)
    return {
      execute: vi.fn(async () => {
        mocks.events.push('gateway:delete:subject')
        if (mocks.protectedGatewayError) throw mocks.protectedGatewayError
      }),
    }
  }),
  createScopedInstanceResetGateway: vi.fn((_database, binding) => {
    mocks.capturedBindings.push(binding)
    return {
      execute: vi.fn(async () => {
        mocks.events.push('gateway:delete:reset')
        if (mocks.protectedGatewayError) throw mocks.protectedGatewayError
      }),
    }
  }),
}))

vi.mock('@/platform/application-coordination/lifecycle-values', () => ({
  createInstallationMutationEpoch: vi.fn((raw: string) => ({ raw })),
  installationMutationEpochMatches: vi.fn(
    (epoch: { raw: string }, raw: string) => epoch.raw === raw,
  ),
}))

vi.mock('@/platform/application-coordination/mutation-authority', () => ({
  createPlatformMutationAuthorityIssuer: vi.fn(() => ({
    authenticatedSession: vi.fn((input) => ({
      expectedEpoch: input.expectedEpoch,
      input,
    })),
    traineeDataDeletionAttempt: vi.fn(({ authenticated }) => {
      const captured = {
        kind: 'destructive-reauthentication-attempt',
        purpose: 'trainee-data-deletion',
        expectedEpoch: authenticated.expectedEpoch,
        actorUserId: authenticated.input.actorUserId,
        sessionId: authenticated.input.sessionId,
        expectedRole: authenticated.input.expectedRole,
        targetUserId: null,
        emailDigest: null,
      }
      return {
        authority: { purpose: 'trainee-data-deletion', captured },
        expectedEpoch: authenticated.expectedEpoch,
      }
    }),
    instanceResetAttempt: vi.fn(({ authenticated }) => {
      const captured = {
        kind: 'destructive-reauthentication-attempt',
        purpose: 'instance-reset',
        expectedEpoch: authenticated.expectedEpoch,
        actorUserId: authenticated.input.actorUserId,
        sessionId: authenticated.input.sessionId,
        expectedRole: authenticated.input.expectedRole,
        targetUserId: null,
        emailDigest: null,
      }
      return {
        authority: { purpose: 'instance-reset', captured },
        expectedEpoch: authenticated.expectedEpoch,
      }
    }),
  })),
}))

vi.mock('@/platform/application-coordination/prelocked-session', () => ({
  createPlatformPrelockedSessionIntentFactory: vi.fn(() => ({
    subjectDeletion: vi.fn((attempt) => ({ attempt })),
    instanceReset: vi.fn((attempt) => ({ attempt })),
  })),
  createPlatformPrelockedSessionPort: vi.fn(() => ({
    withPrelockedSessionLease: vi.fn(async (_intent, callback) => {
      if (mocks.outerBeforeError) throw mocks.outerBeforeError
      const lease = Object.freeze({ lease: mocks.leases.length + 1 })
      mocks.leases.push(lease)
      mocks.events.push('lease:acquired')
      const result = await callback(lease)
      mocks.events.push('lease:callback-resolved')
      if (mocks.outerAfterError) throw mocks.outerAfterError
      mocks.events.push('lease:released')
      return result
    }),
  })),
}))

vi.mock('@/platform/application-coordination/runtime-unit-of-work', () => ({
  createRuntimePostgresUnitOfWork: vi.fn((createGatewayContext) => ({
    run: vi.fn(async (request, callback) => {
      mocks.requests.push(request)
      const phase =
        request.operation === 'destructive-reauthentication-attempt'
          ? 'attempt'
          : 'protected'
      mocks.events.push(`uow:begin:${phase}`)
      const beforeError =
        phase === 'attempt' ? mocks.attemptBeforeError : mocks.protectedBeforeError
      if (beforeError) throw beforeError
      const capturedAuthority =
        request.authority.captured ?? request.authority.protectedCaptured
      const context = createGatewayContext({
        client: { query: vi.fn() },
        request,
        capturedAuthority,
        markReauthenticationSucceeded: () => {
          mocks.events.push(`authority:promoted:${request.authority.purpose}`)
          return {
            kind: 'authenticated-destructive',
            purpose: request.authority.purpose,
            protectedCaptured: {
              ...capturedAuthority,
              kind: 'authenticated-destructive',
            },
          }
        },
        requireWriteAuthorized: vi.fn(),
        exactReplayAuthorizer: null,
        newCommandAuthorizer: null,
      })
      mocks.events.push(`uow:recheck:${phase}`)
      await context.recheckIdentity()
      const result = await callback({
        gateways: { ...context.readGateways, ...context.writeGateways },
      })
      const afterError =
        phase === 'attempt' ? mocks.attemptAfterError : mocks.protectedAfterError
      if (afterError) throw afterError
      mocks.events.push(`uow:commit:${phase}`)
      return result
    }),
  })),
}))

vi.mock('@/platform/application-coordination/scoped-drizzle', () => ({
  createScopedDrizzleDatabase: vi.fn((client) => ({ client })),
}))

vi.mock('@/platform/db/credential-connections', () => {
  class CredentialConnectionCapacityError extends Error {}
  return {
    CredentialConnectionCapacityError,
    withTrustedCredentialCapture: vi.fn(async (callback) => {
      mocks.events.push('capture:trusted')
      if (mocks.trustedCaptureError) throw mocks.trustedCaptureError
      return callback({ query: vi.fn() })
    }),
  }
})

vi.mock('@/platform/db/client', () => ({ getDb: mocks.getDb }))

import {
  type DataPortabilityDestructiveMutationPort,
  getProductionDataPortabilityDestructiveMutationPort,
} from './data-portability-destructive-mutations'

function subjectCommand(): Parameters<
  DataPortabilityDestructiveMutationPort['deleteSubject']
>[0] {
  return {} as Parameters<DataPortabilityDestructiveMutationPort['deleteSubject']>[0]
}

function resetCommand(): Parameters<
  DataPortabilityDestructiveMutationPort['resetInstance']
>[0] {
  return {} as Parameters<DataPortabilityDestructiveMutationPort['resetInstance']>[0]
}

function eventIndex(event: string): number {
  const index = mocks.events.indexOf(event)
  expect(index, `missing event ${event}:\n${mocks.events.join('\n')}`).toBeGreaterThan(-1)
  return index
}

describe('production destructive Data Portability composition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.events.length = 0
    mocks.requests.length = 0
    mocks.leases.length = 0
    mocks.capturedBindings.length = 0
    mocks.attemptInputs.length = 0
    mocks.trustedCaptureError = null
    mocks.outerBeforeError = null
    mocks.outerAfterError = null
    mocks.attemptBeforeError = null
    mocks.attemptAfterError = null
    mocks.protectedBeforeError = null
    mocks.protectedAfterError = null
    mocks.protectedGatewayError = null
    mocks.subjectActionBindingAccepted = true
    mocks.resetActionBindingAccepted = true
    mocks.subjectRecheck = { status: 'current' }
    mocks.resetRecheck = { status: 'current' }
    mocks.subjectAttemptStatus = 'succeeded'
    mocks.resetAttemptStatus = 'succeeded'
    mocks.subjectCommand.planId = 'subject-plan'
    mocks.subjectCommand.planDigest = 'subject-digest'
    mocks.subjectCommand.typedConfirmation = 'DELETE'
    mocks.subjectCommand.acknowledged = true
    mocks.resetCommand.planId = 'reset-plan'
    mocks.resetCommand.planDigest = 'reset-digest'
    mocks.resetCommand.typedConfirmation = 'RESET'
    mocks.resetCommand.acknowledged = true
    mocks.subjectView.expectedRole = 'member'
    mocks.resetView.expectedRole = 'owner'
  })

  it('rejects confirmation and malformed hidden plan fields before any database admission', async () => {
    const port = getProductionDataPortabilityDestructiveMutationPort()
    mocks.subjectCommand.acknowledged = false
    await expect(port.deleteSubject(subjectCommand())).resolves.toEqual({
      kind: 'confirmation-rejected',
    })
    mocks.subjectCommand.acknowledged = true
    mocks.subjectCommand.planId = ''
    await expect(port.deleteSubject(subjectCommand())).resolves.toEqual({
      kind: 'confirmation-rejected',
    })
    mocks.subjectCommand.planId = 'subject-plan'
    mocks.subjectCommand.planDigest = `digest\0tampered`
    await expect(port.deleteSubject(subjectCommand())).resolves.toEqual({
      kind: 'confirmation-rejected',
    })
    mocks.resetCommand.planDigest = 'x'.repeat(513)
    await expect(port.resetInstance(resetCommand())).resolves.toEqual({
      kind: 'confirmation-rejected',
    })
    expect(mocks.events).toEqual([])
    expect(mocks.requests).toEqual([])
    expect(mocks.getDb).not.toHaveBeenCalled()
  })

  it('rejects an inexact action binding at command-entry time before leasing control', async () => {
    mocks.subjectActionBindingAccepted = false
    await expect(
      getProductionDataPortabilityDestructiveMutationPort().deleteSubject(
        subjectCommand(),
      ),
    ).resolves.toEqual({ kind: 'confirmation-rejected' })

    expect(mocks.events).toContain('capture:trusted')
    expect(mocks.events).toContain(
      `binding:subject:subject-binding:${mocks.commandEnteredAt.toISOString()}`,
    )
    expect(mocks.leases).toEqual([])
    expect(mocks.requests).toEqual([])
  })

  it('binds member provenance, runs both UoWs on one lease, and rechecks before gateways', async () => {
    const result =
      await getProductionDataPortabilityDestructiveMutationPort().deleteSubject(
        subjectCommand(),
      )

    expect(result).toEqual({ kind: 'deleted', actorRole: 'member', warning: null })
    expect(mocks.leases).toHaveLength(1)
    expect(mocks.requests).toHaveLength(2)
    expect(mocks.requests[0]).toMatchObject({
      operation: 'destructive-reauthentication-attempt',
      productFence: 'shared',
      subjectLock: null,
      mode: { isolation: 'read-committed', access: 'read-write' },
    })
    expect(mocks.requests[1]).toMatchObject({
      operation: 'subject-deletion',
      productFence: 'shared',
      subjectLock: { subjectUserId: 'member-1', mode: 'exclusive' },
      mode: { isolation: 'serializable', access: 'read-write' },
    })
    expect(mocks.requests[0]?.session.lease).toBe(mocks.leases[0])
    expect(mocks.requests[1]?.session.lease).toBe(mocks.leases[0])
    expect(mocks.capturedBindings).toContainEqual({
      expectedEpoch: mocks.subjectView.expectedEpoch,
      sessionId: mocks.subjectView.sessionId,
      actorUserId: mocks.subjectView.actorUserId,
      planId: mocks.subjectView.planId,
      planDigest: mocks.subjectView.planDigest,
    })
    expect(mocks.capturedBindings).toContainEqual(
      expect.objectContaining({
        actorUserId: 'member-1',
        actorEmail: 'member@example.test',
        actorRole: 'member',
        planId: 'subject-plan',
        planDigest: 'subject-digest',
      }),
    )
    const deletionBinding = mocks.capturedBindings.find(
      (binding) => binding.actorRole === 'member',
    )
    expect(deletionBinding).not.toHaveProperty('completedAt')
    expect(deletionBinding).not.toHaveProperty('tombstoneId')
    expect(mocks.attemptInputs).toContainEqual(
      expect.objectContaining({
        currentPassword: 'member-password',
        requestContext: { channel: 'web', clientAddress: '127.0.0.1' },
      }),
    )
    expect(eventIndex('identity:recheck:subject')).toBeLessThan(
      eventIndex('gateway:reauthenticate:subject'),
    )
    expect(mocks.events.lastIndexOf('identity:recheck:subject')).toBeLessThan(
      eventIndex('gateway:delete:subject'),
    )
    expect(mocks.events.some((event) => event.startsWith('tombstone:'))).toBe(false)
    expect(mocks.getDb).not.toHaveBeenCalled()
  })

  it.each([
    'failed',
    'locked',
  ] as const)('invalidates the subject preview inside the %s attempt UoW and never prepares deletion', async (status) => {
    mocks.subjectAttemptStatus = status
    const result =
      await getProductionDataPortabilityDestructiveMutationPort().deleteSubject(
        subjectCommand(),
      )

    expect(result).toEqual({
      kind: status === 'failed' ? 'reauthentication-failed' : 'reauthentication-locked',
    })
    expect(eventIndex('gateway:reauthenticate:subject')).toBeLessThan(
      eventIndex('gateway:invalidate:subject'),
    )
    expect(eventIndex('gateway:invalidate:subject')).toBeLessThan(
      eventIndex('uow:commit:attempt'),
    )
    expect(mocks.requests).toHaveLength(1)
    expect(mocks.events.some((event) => event.startsWith('tombstone:'))).toBe(false)
    expect(mocks.events).not.toContain('gateway:delete:subject')
  })

  it('invalidates a denied reset preview before committing its attempt UoW', async () => {
    mocks.resetAttemptStatus = 'locked'
    const result =
      await getProductionDataPortabilityDestructiveMutationPort().resetInstance(
        resetCommand(),
      )

    expect(result).toEqual({ kind: 'reauthentication-locked' })
    expect(eventIndex('gateway:reauthenticate:reset')).toBeLessThan(
      eventIndex('gateway:invalidate:reset'),
    )
    expect(eventIndex('gateway:invalidate:reset')).toBeLessThan(
      eventIndex('uow:commit:attempt'),
    )
    expect(mocks.requests).toHaveLength(1)
    expect(mocks.events).not.toContain('gateway:delete:reset')
  })

  it('maps capture and in-transaction authority staleness without running protected DML', async () => {
    const port = getProductionDataPortabilityDestructiveMutationPort()
    mocks.trustedCaptureError = new IdentityDestructiveMutationAuthorityUnavailableError()
    await expect(port.deleteSubject(subjectCommand())).resolves.toEqual({ kind: 'stale' })

    mocks.trustedCaptureError = null
    mocks.subjectRecheck = {
      status: 'stale',
      reason: 'installation-epoch-changed',
    }
    await expect(port.deleteSubject(subjectCommand())).resolves.toEqual({ kind: 'stale' })
    expect(mocks.events).not.toContain('gateway:reauthenticate:subject')
    expect(mocks.events).not.toContain('gateway:delete:subject')
  })

  it('maps capture capacity and pre-DML lock pressure to unavailable', async () => {
    const port = getProductionDataPortabilityDestructiveMutationPort()
    mocks.trustedCaptureError = new CredentialConnectionCapacityError({
      cause: new CoordinationError('uow.capacity'),
    })
    await expect(port.deleteSubject(subjectCommand())).resolves.toEqual({
      kind: 'unavailable',
    })

    mocks.trustedCaptureError = null
    mocks.attemptBeforeError = new CoordinationError('uow.lock-timeout')
    await expect(port.deleteSubject(subjectCommand())).resolves.toEqual({
      kind: 'unavailable',
    })
    expect(mocks.events).not.toContain('gateway:reauthenticate:subject')
  })

  it.each([
    'uow.commit-outcome-unknown',
    'uow.cleanup-failed',
  ] as const)('reports an incomplete reauthentication when the attempt ends with %s', async (code) => {
    mocks.attemptAfterError = new CoordinationError(code)
    await expect(
      getProductionDataPortabilityDestructiveMutationPort().deleteSubject(
        subjectCommand(),
      ),
    ).resolves.toEqual({ kind: 'reauthentication-incomplete' })
    expect(mocks.events).toContain('gateway:reauthenticate:subject')
    expect(mocks.events).not.toContain('gateway:delete:subject')
  })

  it('distinguishes final commit uncertainty from confirmed cleanup failure', async () => {
    const port = getProductionDataPortabilityDestructiveMutationPort()
    mocks.protectedAfterError = new CoordinationError('uow.commit-outcome-unknown')
    await expect(port.deleteSubject(subjectCommand())).resolves.toEqual({
      kind: 'outcome-unknown',
      actorRole: 'member',
    })

    mocks.protectedAfterError = new CoordinationError('uow.cleanup-failed')
    await expect(port.deleteSubject(subjectCommand())).resolves.toEqual({
      kind: 'deleted',
      actorRole: 'member',
      warning: 'cleanup-failed',
    })
  })

  it.each([
    ['uow.begin-failed', 'protectedBeforeError'],
    ['uow.cancelled', 'protectedBeforeError'],
    ['uow.connection-lost', 'protectedBeforeError'],
    ['uow.cancelled', 'protectedAfterError'],
    ['uow.connection-lost', 'protectedAfterError'],
    ['uow.transaction-aborted', 'protectedAfterError'],
  ] as const)('reports protected subject deletion as not applied when %s occurs at %s', async (code, injectionPoint) => {
    mocks[injectionPoint] = new CoordinationError(code)

    await expect(
      getProductionDataPortabilityDestructiveMutationPort().deleteSubject(
        subjectCommand(),
      ),
    ).resolves.toEqual({ kind: 'unavailable' })
    expect(mocks.events).not.toContain('uow:commit:protected')
    if (injectionPoint === 'protectedBeforeError') {
      expect(mocks.events).not.toContain('gateway:delete:subject')
    } else {
      expect(mocks.events).toContain('gateway:delete:subject')
    }
  })

  it.each([
    ['uow.begin-failed', 'protectedBeforeError'],
    ['uow.cancelled', 'protectedBeforeError'],
    ['uow.connection-lost', 'protectedBeforeError'],
    ['uow.cancelled', 'protectedAfterError'],
    ['uow.connection-lost', 'protectedAfterError'],
    ['uow.transaction-aborted', 'protectedAfterError'],
  ] as const)('reports protected instance reset as not applied when %s occurs at %s', async (code, injectionPoint) => {
    mocks[injectionPoint] = new CoordinationError(code)

    await expect(
      getProductionDataPortabilityDestructiveMutationPort().resetInstance(resetCommand()),
    ).resolves.toEqual({ kind: 'unavailable' })
    expect(mocks.events).not.toContain('uow:commit:protected')
    if (injectionPoint === 'protectedBeforeError') {
      expect(mocks.events).not.toContain('gateway:delete:reset')
    } else {
      expect(mocks.events).toContain('gateway:delete:reset')
    }
  })

  it.each([
    'uow.cleanup-failed',
    'uow.connection-lost',
    'uow.cancelled',
  ] as const)('preserves confirmed subject success when the outer lease ends with %s', async (code) => {
    mocks.outerAfterError = new CoordinationError(code)
    await expect(
      getProductionDataPortabilityDestructiveMutationPort().deleteSubject(
        subjectCommand(),
      ),
    ).resolves.toEqual({
      kind: 'deleted',
      actorRole: 'member',
      warning: 'cleanup-failed',
    })
    expect(mocks.events).toContain('uow:commit:protected')
  })

  it.each([
    'uow.cleanup-failed',
    'uow.connection-lost',
    'uow.cancelled',
  ] as const)('preserves confirmed reset success when the outer lease ends with %s', async (code) => {
    mocks.outerAfterError = new CoordinationError(code)
    await expect(
      getProductionDataPortabilityDestructiveMutationPort().resetInstance(resetCommand()),
    ).resolves.toEqual({ kind: 'reset', warning: 'cleanup-failed' })
    expect(mocks.events).toContain('uow:commit:protected')
  })

  it('preserves a confirmed denial when the outer lease fails afterward', async () => {
    mocks.subjectAttemptStatus = 'failed'
    mocks.outerAfterError = new CoordinationError('uow.connection-lost')

    await expect(
      getProductionDataPortabilityDestructiveMutationPort().deleteSubject(
        subjectCommand(),
      ),
    ).resolves.toEqual({ kind: 'reauthentication-failed' })
    expect(mocks.events).toContain('uow:commit:attempt')
    expect(mocks.events).not.toContain('uow:begin:protected')
  })

  it.each([
    ['deletion.plan-invalid', 'plan-invalid'],
    ['deletion.plan-changed', 'plan-changed'],
  ] as const)('maps %s without obscuring the preview disposition', async (code, kind) => {
    mocks.protectedGatewayError = new DeletionError(code, 'planned failure')
    await expect(
      getProductionDataPortabilityDestructiveMutationPort().deleteSubject(
        subjectCommand(),
      ),
    ).resolves.toEqual({ kind })
  })

  it('runs owner reset under an exclusive product fence with no subject lock', async () => {
    const result =
      await getProductionDataPortabilityDestructiveMutationPort().resetInstance(
        resetCommand(),
      )

    expect(result).toEqual({ kind: 'reset', warning: null })
    expect(mocks.requests).toHaveLength(2)
    expect(mocks.requests[0]).toMatchObject({
      operation: 'destructive-reauthentication-attempt',
      productFence: 'shared',
      subjectLock: null,
    })
    expect(mocks.requests[1]).toMatchObject({
      operation: 'instance-reset',
      productFence: 'exclusive',
      subjectLock: null,
      mode: { isolation: 'serializable', access: 'read-write' },
    })
    expect(mocks.requests[0]?.session.lease).toBe(mocks.requests[1]?.session.lease)
    expect(eventIndex('identity:recheck:reset')).toBeLessThan(
      eventIndex('gateway:reauthenticate:reset'),
    )
    expect(mocks.events.lastIndexOf('identity:recheck:reset')).toBeLessThan(
      eventIndex('gateway:delete:reset'),
    )
  })

  it('keeps malformed database shapes and unclassified protected errors exceptional', async () => {
    const port = getProductionDataPortabilityDestructiveMutationPort()
    mocks.trustedCaptureError = new IdentityDestructiveMutationCaptureInvariantError()
    await expect(port.deleteSubject(subjectCommand())).rejects.toBe(
      mocks.trustedCaptureError,
    )

    const unexpected = new Error('unexpected adapter failure')
    mocks.trustedCaptureError = null
    mocks.protectedGatewayError = unexpected
    await expect(port.deleteSubject(subjectCommand())).rejects.toBe(unexpected)
  })
})
