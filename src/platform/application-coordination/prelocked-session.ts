import type { PoolClient } from 'pg'
import { CoordinationError, type UnitOfWorkRequest } from '@/application/coordination'
import {
  PrelockedSessionIntent,
  PrelockedSessionLease,
  type PrelockedSessionOperation,
  type PrelockedSessionOptions,
  type PrelockedSessionPort,
} from '@/application/coordination/prelocked-session'

export type AcquiredPrelockedSession = {
  readonly client: PoolClient
  /**
   * Releases credential locks in reverse, then reads the live destruction cause immediately
   * before returning or destroying the reserved client.
   */
  close(destroyError: () => Error | undefined): Promise<void>
}

export type AcquirePrelockedSession = (
  options: PrelockedSessionOptions,
) => Promise<AcquiredPrelockedSession>

const prelockedConstructionToken = Object.freeze({})

type IntentState<Operation extends PrelockedSessionOperation> = {
  consumed: boolean
  readonly operation: Operation
  readonly acquire: AcquirePrelockedSession
}

const intentStates = new WeakMap<object, IntentState<PrelockedSessionOperation>>()

class PlatformPrelockedSessionIntent<
  Operation extends PrelockedSessionOperation,
> extends PrelockedSessionIntent<Operation> {
  constructor(
    token: typeof prelockedConstructionToken,
    operation: Operation,
    acquire: AcquirePrelockedSession,
  ) {
    super()
    if (token !== prelockedConstructionToken) {
      throw new CoordinationError('uow.prelocked-session-invalid')
    }
    intentStates.set(this, { consumed: false, operation, acquire })
  }
}

function consumeIntent<Operation extends PrelockedSessionOperation>(
  intent: PrelockedSessionIntent<Operation>,
): {
  readonly operation: Operation
  readonly acquire: AcquirePrelockedSession
} {
  const state = intentStates.get(intent) as IntentState<Operation> | undefined
  if (!state || state.consumed) {
    throw new CoordinationError('uow.prelocked-session-invalid')
  }
  state.consumed = true
  return { operation: state.operation, acquire: state.acquire }
}

type LeaseState<Operation extends PrelockedSessionOperation> = {
  active: boolean
  inUnitOfWork: boolean
  readonly operation: Operation
  readonly session: AcquiredPrelockedSession
  destroyError: Error | undefined
  currentExecution: LeaseExecutionState | undefined
  readonly executions: LeaseExecutionState[]
  fail(error: Error): void
}

type LeaseExecutionState = {
  readonly abortController: AbortController
  observed: boolean
  settled: boolean
  promise: Promise<unknown> | undefined
}

const leaseStates = new WeakMap<object, LeaseState<PrelockedSessionOperation>>()

class PlatformPrelockedSessionLease<
  Operation extends PrelockedSessionOperation,
> extends PrelockedSessionLease<Operation> {
  constructor(token: typeof prelockedConstructionToken, state: LeaseState<Operation>) {
    super()
    if (token !== prelockedConstructionToken) {
      throw new CoordinationError('uow.prelocked-session-invalid')
    }
    leaseStates.set(this, state as LeaseState<PrelockedSessionOperation>)
  }
}

function leaseState<Operation extends PrelockedSessionOperation>(
  lease: PrelockedSessionLease<Operation>,
): LeaseState<Operation> {
  const state = leaseStates.get(lease) as LeaseState<Operation> | undefined
  if (!state) throw new CoordinationError('uow.prelocked-session-invalid')
  return state
}

export type PlatformPrelockedSessionIntentFactory = {
  emailSignIn(acquire: AcquirePrelockedSession): PrelockedSessionIntent<'email-sign-in'>
  memberResetRedemption(
    acquire: AcquirePrelockedSession,
  ): PrelockedSessionIntent<'member-reset-redemption'>
  ownerRecoveryWebRedemption(
    acquire: AcquirePrelockedSession,
  ): PrelockedSessionIntent<'owner-recovery-web-redemption'>
  bootstrapIssuance(
    acquire: AcquirePrelockedSession,
  ): PrelockedSessionIntent<'bootstrap-issuance'>
  bootstrapRedemption(
    acquire: AcquirePrelockedSession,
  ): PrelockedSessionIntent<'bootstrap-redemption'>
  checkedSignOut(
    acquire: AcquirePrelockedSession,
  ): PrelockedSessionIntent<'checked-sign-out'>
  expiredSessionMaintenance(
    acquire: AcquirePrelockedSession,
  ): PrelockedSessionIntent<'expired-session-maintenance'>
  instanceReset(
    acquire: AcquirePrelockedSession,
  ): PrelockedSessionIntent<'instance-reset'>
  localUserCreate(
    acquire: AcquirePrelockedSession,
  ): PrelockedSessionIntent<'local-user-create'>
  memberResetIssue(
    acquire: AcquirePrelockedSession,
  ): PrelockedSessionIntent<'member-reset-issue'>
  ownerRecoveryCliRedemption(
    acquire: AcquirePrelockedSession,
  ): PrelockedSessionIntent<'owner-recovery-cli-redemption'>
  ownerRecoveryIssue(
    acquire: AcquirePrelockedSession,
  ): PrelockedSessionIntent<'owner-recovery-issue'>
  subjectDeletion(
    acquire: AcquirePrelockedSession,
  ): PrelockedSessionIntent<'subject-deletion'>
}

function intent<Operation extends PrelockedSessionOperation>(
  operation: Operation,
  acquire: AcquirePrelockedSession,
): PrelockedSessionIntent<Operation> {
  return new PlatformPrelockedSessionIntent(
    prelockedConstructionToken,
    operation,
    acquire,
  )
}

/** Explicit named methods prevent callers from promoting a string to a trusted operation. */
export function createPlatformPrelockedSessionIntentFactory(): PlatformPrelockedSessionIntentFactory {
  return {
    emailSignIn: (acquire) => intent('email-sign-in', acquire),
    memberResetRedemption: (acquire) => intent('member-reset-redemption', acquire),
    ownerRecoveryWebRedemption: (acquire) =>
      intent('owner-recovery-web-redemption', acquire),
    bootstrapIssuance: (acquire) => intent('bootstrap-issuance', acquire),
    bootstrapRedemption: (acquire) => intent('bootstrap-redemption', acquire),
    checkedSignOut: (acquire) => intent('checked-sign-out', acquire),
    expiredSessionMaintenance: (acquire) =>
      intent('expired-session-maintenance', acquire),
    instanceReset: (acquire) => intent('instance-reset', acquire),
    localUserCreate: (acquire) => intent('local-user-create', acquire),
    memberResetIssue: (acquire) => intent('member-reset-issue', acquire),
    ownerRecoveryCliRedemption: (acquire) =>
      intent('owner-recovery-cli-redemption', acquire),
    ownerRecoveryIssue: (acquire) => intent('owner-recovery-issue', acquire),
    subjectDeletion: (acquire) => intent('subject-deletion', acquire),
  }
}

export type ResolvedPlatformPrelockedSession = {
  readonly client: PoolClient
  readonly signal: AbortSignal
  finish(): void
  destroy(error: Error): void
}

export function prelockedOperationForRequest(
  request: UnitOfWorkRequest,
): PrelockedSessionOperation {
  if (request.session.kind !== 'prelocked') {
    throw new CoordinationError('uow.prelocked-session-invalid')
  }
  switch (request.operation) {
    case 'subject-deletion':
      return 'subject-deletion'
    case 'instance-reset':
      return 'instance-reset'
    case 'destructive-reauthentication-attempt':
      if (request.authority.kind !== 'destructive-reauthentication-attempt') break
      switch (request.authority.purpose) {
        case 'trainee-data-deletion':
          return 'subject-deletion'
        case 'instance-reset':
          return 'instance-reset'
        case 'member-reset-issue':
          return 'member-reset-issue'
        case 'local-user-create':
          return 'local-user-create'
      }
      break
    case 'destructive-identity-mutation':
      if (request.authority.kind !== 'authenticated-destructive') break
      if (request.authority.purpose === 'member-reset-issue') {
        return 'member-reset-issue'
      }
      if (request.authority.purpose === 'local-user-create') {
        return 'local-user-create'
      }
      break
    case 'credential-lifecycle-mutation':
      if (
        request.authority.kind === 'credential-lifecycle' &&
        [
          'email-sign-in',
          'checked-sign-out',
          'member-reset-redemption',
          'owner-recovery-web-redemption',
          'owner-recovery-cli-redemption',
        ].includes(request.authority.mutation)
      ) {
        return request.authority.mutation
      }
      break
    case 'host-bootstrap-mutation':
      if (request.authority.kind !== 'host-bootstrap') break
      if (request.authority.mutation === 'issuance') return 'bootstrap-issuance'
      if (request.authority.mutation === 'redemption') return 'bootstrap-redemption'
      break
    case 'host-maintenance':
      if (request.authority.kind === 'owner-recovery-issue') {
        return 'owner-recovery-issue'
      }
      if (request.authority.kind === 'expired-session-maintenance') {
        return 'expired-session-maintenance'
      }
      break
    default:
      break
  }
  throw new CoordinationError('uow.prelocked-session-invalid')
}

export function resolvePlatformPrelockedSession(
  lease: PrelockedSessionLease<PrelockedSessionOperation>,
  expectedOperation: PrelockedSessionOperation,
): ResolvedPlatformPrelockedSession {
  const state = leaseState(lease)
  if (
    !state.active ||
    state.inUnitOfWork ||
    state.operation !== expectedOperation ||
    state.destroyError
  ) {
    throw new CoordinationError('uow.prelocked-session-invalid')
  }
  state.inUnitOfWork = true
  const execution: LeaseExecutionState = {
    abortController: new AbortController(),
    observed: false,
    settled: false,
    promise: undefined,
  }
  state.currentExecution = execution
  state.executions.push(execution)
  let finished = false
  return {
    client: state.session.client,
    signal: execution.abortController.signal,
    finish() {
      if (finished) return
      finished = true
      state.inUnitOfWork = false
      state.currentExecution = undefined
      if (!execution.promise) {
        execution.observed = true
        execution.settled = true
      }
    },
    destroy(error) {
      state.fail(error)
    },
  }
}

function trackedPrelockedExecution<Result>(
  state: LeaseExecutionState,
  promise: Promise<Result>,
  visiblePromise = promise,
): Promise<Result> {
  const observe = (): void => {
    state.observed = true
  }
  return {
    // biome-ignore lint/suspicious/noThenProperty: awaiting the wrapper records that the inner UoW was joined
    then(onfulfilled, onrejected) {
      observe()
      const chained = visiblePromise.then(onfulfilled, onrejected)
      void chained.catch(() => undefined)
      return chained
    },
    catch(onrejected) {
      const chained = visiblePromise.catch(onrejected)
      void chained.catch(() => undefined)
      return trackedPrelockedExecution(state, promise, chained)
    },
    finally(onfinally) {
      const chained = visiblePromise.finally(onfinally)
      void chained.catch(() => undefined)
      return trackedPrelockedExecution(state, promise, chained)
    },
    [Symbol.toStringTag]: 'Promise',
  } as Promise<Result>
}

export function bindPrelockedSessionExecution<Result>(
  lease: PrelockedSessionLease<PrelockedSessionOperation>,
  promise: Promise<Result>,
): Promise<Result> {
  let state: LeaseState<PrelockedSessionOperation>
  try {
    state = leaseState(lease)
  } catch (error) {
    void promise.catch(() => undefined)
    throw error
  }
  const execution = state.currentExecution
  if (!state.active || !state.inUnitOfWork || !execution || execution.promise) {
    void promise.catch(() => undefined)
    throw new CoordinationError('uow.prelocked-session-invalid')
  }
  execution.promise = promise
  void promise.then(
    () => {
      execution.settled = true
    },
    () => {
      execution.settled = true
    },
  )
  return trackedPrelockedExecution(execution, promise)
}

class PlatformPrelockedSessionPort implements PrelockedSessionPort {
  #activeScopes = 0
  readonly #detachedDrainTimeoutMs: number

  constructor(detachedDrainTimeoutMs: number) {
    this.#detachedDrainTimeoutMs = detachedDrainTimeoutMs
  }

  async withPrelockedSessionLease<Operation extends PrelockedSessionOperation, Result>(
    intentValue: PrelockedSessionIntent<Operation>,
    callback: (lease: PrelockedSessionLease<Operation>) => Promise<Result>,
    options: PrelockedSessionOptions = {},
  ): Promise<Result> {
    const captured = consumeIntent(intentValue)
    if (options.signal?.aborted) throw new CoordinationError('uow.cancelled')
    const session = await captured.acquire(options)
    if (options.signal?.aborted) {
      const error = new CoordinationError('uow.cancelled')
      await session.close(() => error)
      throw error
    }
    let rejectLeaseFailure: (error: CoordinationError) => void = () => undefined
    const leaseFailure = new Promise<never>((_resolve, reject) => {
      rejectLeaseFailure = reject
    })
    void leaseFailure.catch(() => undefined)
    let state: LeaseState<typeof captured.operation>
    const fail = (error: Error): void => {
      if (state.destroyError) return
      state.destroyError = error
      state.active = false
      state.currentExecution?.abortController.abort(error)
      rejectLeaseFailure(new CoordinationError('uow.connection-lost'))
    }
    state = {
      active: true,
      inUnitOfWork: false,
      operation: captured.operation,
      session,
      destroyError: undefined,
      currentExecution: undefined,
      executions: [],
      fail,
    }
    const onConnectionError = (error: Error): void => {
      state.fail(error)
    }
    let cancellationError: CoordinationError | undefined
    let rejectCancellation: (error: CoordinationError) => void = () => undefined
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject
    })
    void cancellation.catch(() => undefined)
    const onCancellation = (): void => {
      if (cancellationError) return
      cancellationError = new CoordinationError('uow.cancelled')
      state.active = false
      state.currentExecution?.abortController.abort(cancellationError)
      rejectCancellation(cancellationError)
    }
    session.client.on('error', onConnectionError)
    options.signal?.addEventListener('abort', onCancellation, { once: true })
    const lease = new PlatformPrelockedSessionLease(prelockedConstructionToken, state)
    this.#activeScopes += 1
    let outcome:
      | { readonly ok: true; readonly value: Result }
      | { readonly ok: false; readonly error: unknown }
    try {
      try {
        outcome = {
          ok: true,
          value: await Promise.race([
            Promise.resolve(callback(lease)),
            cancellation,
            leaseFailure,
          ]),
        }
      } catch (error) {
        outcome = { ok: false, error }
      }
      const detachedExecutions = state.executions.filter(
        (execution) => !execution.observed || !execution.settled,
      )
      if (state.inUnitOfWork || detachedExecutions.length > 0) {
        const error = new CoordinationError('uow.detached-work')
        state.destroyError ??= error
        for (const execution of detachedExecutions) {
          execution.abortController.abort()
        }
        const promises = detachedExecutions.flatMap((execution) =>
          execution.promise ? [execution.promise] : [],
        )
        if (promises.length > 0) {
          let timeout: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              Promise.allSettled(promises),
              new Promise<void>((resolve) => {
                timeout = setTimeout(resolve, this.#detachedDrainTimeoutMs)
              }),
            ])
          } finally {
            if (timeout) clearTimeout(timeout)
          }
        }
        if (outcome.ok) outcome = { ok: false, error }
      }
      if (state.destroyError && outcome.ok) {
        outcome = {
          ok: false,
          error: new CoordinationError('uow.connection-lost'),
        }
      }
      if (cancellationError && outcome.ok) {
        outcome = { ok: false, error: cancellationError }
      }
    } finally {
      state.active = false
    }

    let cleanupError: unknown
    try {
      try {
        await session.close(() => state.destroyError)
      } catch (error) {
        cleanupError = error
      }
    } finally {
      session.client.removeListener('error', onConnectionError)
      options.signal?.removeEventListener('abort', onCancellation)
      this.#activeScopes -= 1
    }

    if (state.destroyError && outcome.ok) {
      outcome = { ok: false, error: new CoordinationError('uow.connection-lost') }
    }

    if (!outcome.ok) throw outcome.error
    if (cleanupError !== undefined) throw new CoordinationError('uow.cleanup-failed')
    return outcome.value
  }

  activeLeaseScopeCount(): number {
    return this.#activeScopes
  }
}

export function createPlatformPrelockedSessionPort(
  options: { readonly detachedDrainTimeoutMs?: number } = {},
): PrelockedSessionPort {
  const detachedDrainTimeoutMs = options.detachedDrainTimeoutMs ?? 250
  if (!Number.isInteger(detachedDrainTimeoutMs) || detachedDrainTimeoutMs <= 0) {
    throw new TypeError('Prelocked-session detached drain timeout must be positive.')
  }
  return new PlatformPrelockedSessionPort(detachedDrainTimeoutMs)
}
