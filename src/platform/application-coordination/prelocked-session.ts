import { performance } from 'node:perf_hooks'
import type { PoolClient } from 'pg'
import {
  CoordinationError,
  type MutationAuthority,
  type UnitOfWorkRequest,
} from '@/application/coordination'
import {
  PrelockedSessionIntent,
  PrelockedSessionLease,
  type PrelockedSessionOperation,
  type PrelockedSessionOptions,
  type PrelockedSessionPort,
} from '@/application/coordination/prelocked-session'
import {
  acquireSubmittedEmailPrelockedControlClient,
  acquireTrustedPrelockedControlClient,
} from '@/platform/db/prelocked-control-client'
import {
  assertPlatformMutationAuthorityScope,
  bindPlatformMutationAuthorityScope,
  consumePlatformCredentialPrelockPlan,
  type IssuedCredentialLifecycle,
  type IssuedDestructiveAttempt,
  type IssuedExpiredSessionMaintenance,
  type IssuedHostBootstrap,
  type IssuedMutationAuthority,
  type IssuedOwnerRecovery,
  type PlatformMutationAuthorityScope,
  revokePlatformMutationAuthorityScope,
} from './mutation-authority'
import {
  connectionFailure,
  guardedInFlightQuery,
  InFlightQueryUncertain,
  lockTimeout,
} from './postgres-query-guard'

type AcquiredPrelockedSession = {
  readonly client: PoolClient
  connectionError(): Error | undefined
  subscribeConnectionError(listener: (error: Error) => void): () => void
  /**
   * Releases credential locks in reverse, then reads the live destruction cause immediately
   * before returning or destroying the reserved client.
   */
  close(destroyError: () => Error | undefined): Promise<void>
}

const credentialLockNamespace = 'indigo:credential-lifecycle:'
type CredentialLock = {
  readonly key: string
  readonly mode: 'exclusive' | 'shared'
}

type ExternalHostConnectionState = {
  status: 'available' | 'closed' | 'in-use'
  readonly hostInvocationId: string
  readonly client: PoolClient
  readonly closeTimeoutMs: number
  readonly close: (error: Error | undefined) => Promise<void> | void
  readonly forceDestroy: (error: Error) => void
  readonly monitor: ClientErrorMonitor
}

type ClientErrorMonitor = {
  readonly error: () => Error | undefined
  readonly dispose: () => void
  readonly subscribe: (listener: (error: Error) => void) => () => void
}

function monitorClientErrors(client: PoolClient): ClientErrorMonitor {
  let observed: Error | undefined
  const listeners = new Set<(error: Error) => void>()
  const onError = (error: Error): void => {
    if (observed) return
    observed = errorForHostClose(error)
    for (const listener of listeners) listener(observed)
  }
  client.on('error', onError)
  return {
    error: () => observed,
    dispose() {
      listeners.clear()
      client.removeListener('error', onError)
    },
    subscribe(listener) {
      if (observed) {
        listener(observed)
        return () => undefined
      }
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Platform-only, one-shot ownership of the separately serialized host connection. */
export abstract class PlatformExternalHostConnection {
  protected declare readonly platformExternalHostConnectionNominal: never

  protected constructor() {}
}

const externalHostConnectionToken = Object.freeze({})
const externalHostConnectionStates = new WeakMap<object, ExternalHostConnectionState>()

class ConcretePlatformExternalHostConnection extends PlatformExternalHostConnection {
  constructor(
    token: typeof externalHostConnectionToken,
    state: ExternalHostConnectionState,
  ) {
    super()
    if (token !== externalHostConnectionToken) {
      throw new CoordinationError('uow.prelocked-session-invalid')
    }
    externalHostConnectionStates.set(this, state)
  }
}

type ExternalHostOutcome<Result> =
  | { readonly ok: true; readonly value: Result }
  | { readonly ok: false; readonly error: unknown }

/**
 * Exact Platform host adapter seam. It selects only connection ownership; mutation authority still
 * fixes lane, operation, and every lock coordinate inside the private scope.
 */
export async function withPlatformExternalHostConnection<Result>(
  input: {
    readonly hostInvocationId: string
    readonly client: PoolClient
    readonly closeTimeoutMs?: number
    readonly close: (error: Error | undefined) => Promise<void> | void
    /** Must synchronously hard-destroy the socket when graceful close misses its bound. */
    readonly forceDestroy: (error: Error) => void
  },
  callback: (connection: PlatformExternalHostConnection) => Promise<Result>,
): Promise<Result> {
  if (!input.hostInvocationId || typeof input.hostInvocationId !== 'string') {
    throw new TypeError('External host invocation identity is required.')
  }
  if (typeof input.close !== 'function' || typeof input.forceDestroy !== 'function') {
    throw new TypeError('External host close ownership is required.')
  }
  const closeTimeoutMs = input.closeTimeoutMs ?? 30_000
  if (!Number.isInteger(closeTimeoutMs) || closeTimeoutMs <= 0) {
    throw new TypeError('External host close timeout must be positive.')
  }
  const monitor = monitorClientErrors(input.client)
  const state: ExternalHostConnectionState = {
    status: 'available',
    hostInvocationId: input.hostInvocationId,
    client: input.client,
    closeTimeoutMs,
    close: input.close,
    forceDestroy: input.forceDestroy,
    monitor,
  }
  const connection = new ConcretePlatformExternalHostConnection(
    externalHostConnectionToken,
    state,
  )
  let outcome: ExternalHostOutcome<Result>
  try {
    outcome = { ok: true, value: await callback(connection) }
  } catch (error) {
    outcome = { ok: false, error }
  }

  const connectionErrorBeforeClose = state.monitor.error()
  let closeError: unknown
  if (state.status !== 'closed') {
    try {
      await closeExternalHostState(
        state,
        outcome.ok ? connectionErrorBeforeClose : errorForHostClose(outcome.error),
      )
    } catch (error) {
      closeError = error
    }
  }
  if (!outcome.ok) throw outcome.error
  if (state.monitor.error()) throw new CoordinationError('uow.connection-lost')
  if (closeError !== undefined) throw closeError
  return outcome.value
}

function errorForHostClose(error: unknown): Error {
  return error instanceof Error ? error : new Error('External host callback failed.')
}

async function closeExternalHostState(
  state: ExternalHostConnectionState,
  error: Error | undefined,
): Promise<void> {
  if (state.status === 'closed') return
  state.status = 'closed'
  const timeoutError = new CoordinationError('uow.cleanup-failed')
  const closePromise = Promise.resolve().then(() => state.close(error))
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    closePromise.then(
      () => ({ kind: 'closed' as const }),
      (closeError: unknown) => ({ kind: 'failed' as const, error: closeError }),
    ),
    new Promise<{ readonly kind: 'timed-out' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timed-out' }), state.closeTimeoutMs)
    }),
  ])
  if (timer) clearTimeout(timer)
  try {
    if (outcome.kind === 'failed') {
      try {
        state.forceDestroy(errorForHostClose(outcome.error))
      } catch {
        // The graceful-close failure remains the stable outcome. The synchronous hard-destroy
        // fallback was still attempted and there is no safer owner to transfer the client to.
      }
      throw outcome.error
    }
    if (outcome.kind === 'timed-out') {
      void closePromise.catch(() => undefined)
      try {
        state.forceDestroy(error ?? timeoutError)
      } catch {
        // Preserve the bounded cleanup outcome even if the final hard-destroy attempt also fails.
      }
      throw timeoutError
    }
  } finally {
    state.monitor.dispose()
  }
}

function credentialLocks(input: {
  readonly instanceFence: 'exclusive' | 'shared'
  readonly emailDigest: string | null
  readonly accountUserIds: readonly string[]
  readonly unknownAccountEmailDigest: string | null
}): readonly CredentialLock[] {
  const locks: CredentialLock[] = [
    {
      key: `${credentialLockNamespace}instance-fence`,
      mode: input.instanceFence,
    },
  ]
  if (input.emailDigest) {
    locks.push({
      key: `${credentialLockNamespace}email:${input.emailDigest}`,
      mode: 'exclusive',
    })
  }
  if (input.accountUserIds.length > 0 && input.unknownAccountEmailDigest) {
    throw new CoordinationError('uow.prelocked-session-invalid')
  }
  if (input.unknownAccountEmailDigest) {
    locks.push({
      key: `${credentialLockNamespace}unknown-account:${input.unknownAccountEmailDigest}`,
      mode: 'exclusive',
    })
  } else {
    for (const accountUserId of input.accountUserIds) {
      locks.push({
        key: `${credentialLockNamespace}account:${accountUserId}`,
        mode: 'exclusive',
      })
    }
  }
  return locks
}

function lockStatement(mode: CredentialLock['mode']): string {
  return mode === 'shared'
    ? 'SELECT pg_advisory_lock_shared(hashtextextended($1, 0))'
    : 'SELECT pg_advisory_lock(hashtextextended($1, 0))'
}

function unlockStatement(mode: CredentialLock['mode']): string {
  return mode === 'shared'
    ? 'SELECT pg_advisory_unlock_shared(hashtextextended($1, 0)) AS unlocked'
    : 'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked'
}

async function releaseCredentialLocks(
  client: PoolClient,
  monitor: ClientErrorMonitor,
  acquired: readonly CredentialLock[],
  deadline: number,
): Promise<{
  readonly canContinue: boolean
  readonly firstError: unknown
}> {
  let firstError: unknown
  for (const lock of [...acquired].reverse()) {
    const remaining = Math.ceil(deadline - performance.now())
    if (remaining <= 0) {
      firstError ??= new CoordinationError('uow.cleanup-failed')
      return { canContinue: false, firstError }
    }
    try {
      const result = await guardedPrelockQuery<{ unlocked: boolean }>(
        client,
        unlockStatement(lock.mode),
        [lock.key],
        {
          monitor,
          timeoutMs: remaining,
          timeoutError: new CoordinationError('uow.cleanup-failed'),
        },
      )
      if (result.rows[0]?.unlocked !== true) {
        throw new Error('A coordinated advisory lock was not held at cleanup.')
      }
    } catch (error) {
      firstError ??= error
      if (error instanceof InFlightQueryUncertain || connectionFailure(error)) {
        return { canContinue: false, firstError }
      }
    }
  }
  return { canContinue: true, firstError }
}

async function cleanupCredentialLockState(
  client: PoolClient,
  monitor: ClientErrorMonitor,
  acquired: readonly CredentialLock[],
  lockTimeoutConfigured: boolean,
  queryTimeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + queryTimeoutMs
  const released = await releaseCredentialLocks(client, monitor, acquired, deadline)
  let firstError = released.firstError
  if (lockTimeoutConfigured && released.canContinue) {
    const remaining = Math.ceil(deadline - performance.now())
    if (remaining <= 0) {
      firstError ??= new CoordinationError('uow.cleanup-failed')
    } else {
      try {
        await guardedPrelockQuery(client, 'RESET lock_timeout', undefined, {
          monitor,
          timeoutMs: remaining,
          timeoutError: new CoordinationError('uow.cleanup-failed'),
        })
      } catch (error) {
        firstError ??= error
      }
    }
  }
  if (firstError !== undefined) throw firstError
}

function guardedPrelockQuery<Row extends Record<string, unknown>>(
  client: PoolClient,
  text: string,
  values: readonly unknown[] | undefined,
  options: {
    readonly monitor: ClientErrorMonitor
    readonly signal?: AbortSignal
    readonly timeoutMs: number
    readonly timeoutError: CoordinationError
  },
) {
  const promise = values ? client.query<Row>(text, [...values]) : client.query<Row>(text)
  return guardedInFlightQuery({
    promise,
    signal: options.signal,
    subscribeUncertain: (fail) =>
      options.monitor.subscribe(() => fail(new CoordinationError('uow.connection-lost'))),
    timeoutMs: options.timeoutMs,
    timeoutError: options.timeoutError,
    onUncertain: () => undefined,
  })
}

function externalHostRelease(
  connection: PlatformExternalHostConnection | undefined,
  expectedInvocationId: string,
): {
  readonly client: PoolClient
  readonly monitor: ClientErrorMonitor
  close(error: Error | undefined): Promise<void>
} {
  const state = connection ? externalHostConnectionStates.get(connection) : undefined
  if (state?.status !== 'available' || state.hostInvocationId !== expectedInvocationId) {
    throw new CoordinationError('uow.prelocked-session-invalid')
  }
  if (state.monitor.error()) {
    throw new CoordinationError('uow.connection-lost')
  }
  state.status = 'in-use'
  return {
    client: state.client,
    monitor: state.monitor,
    async close(error) {
      if (state.status !== 'in-use') return
      await closeExternalHostState(state, error)
    },
  }
}

async function acquirePrelockedSession(
  authorityScope: PlatformMutationAuthorityScope,
  externalHostConnection: PlatformExternalHostConnection | undefined,
  options: PrelockedSessionOptions,
  lockTimeoutMs: number,
  queryTimeoutMs: number,
): Promise<AcquiredPrelockedSession> {
  const plan = consumePlatformCredentialPrelockPlan(authorityScope)
  if (options.signal?.aborted) throw new CoordinationError('uow.cancelled')

  let client: PoolClient
  let monitor: ClientErrorMonitor
  let closeClient: (error: Error | undefined) => Promise<void>
  if (plan.lane === 'external-host') {
    if (!plan.hostInvocationId) {
      throw new CoordinationError('uow.prelocked-session-invalid')
    }
    const external = externalHostRelease(externalHostConnection, plan.hostInvocationId)
    client = external.client
    monitor = external.monitor
    closeClient = external.close
  } else {
    const acquired = await (plan.lane === 'submitted-email'
      ? acquireSubmittedEmailPrelockedControlClient(options)
      : acquireTrustedPrelockedControlClient(options))
    client = acquired.client
    monitor = acquired
    closeClient = async (error) => {
      client.release(error)
    }
  }

  const closeOwnedClient = async (error: Error | undefined): Promise<void> => {
    try {
      await closeClient(error)
    } finally {
      monitor.dispose()
    }
  }
  const acquired: CredentialLock[] = []
  let lockTimeoutConfigured = false
  const deadline = performance.now() + lockTimeoutMs
  try {
    for (const lock of credentialLocks(plan)) {
      if (options.signal?.aborted) throw new CoordinationError('uow.cancelled')
      const remaining = Math.ceil(deadline - performance.now())
      if (remaining <= 0) throw new CoordinationError('uow.lock-timeout')
      await guardedPrelockQuery(
        client,
        "SELECT set_config('lock_timeout', $1, false)",
        [`${remaining}ms`],
        {
          monitor,
          signal: options.signal,
          timeoutMs: Math.min(remaining, queryTimeoutMs),
          timeoutError: new CoordinationError('uow.lock-timeout'),
        },
      )
      lockTimeoutConfigured = true
      const lockRemaining = Math.ceil(deadline - performance.now())
      if (lockRemaining <= 0) throw new CoordinationError('uow.lock-timeout')
      await guardedPrelockQuery(client, lockStatement(lock.mode), [lock.key], {
        monitor,
        signal: options.signal,
        timeoutMs: Math.min(lockRemaining, queryTimeoutMs),
        timeoutError: new CoordinationError('uow.lock-timeout'),
      })
      acquired.push(lock)
    }
    if (monitor.error()) {
      throw new InFlightQueryUncertain(new CoordinationError('uow.connection-lost'))
    }
    if (options.signal?.aborted) throw new CoordinationError('uow.cancelled')
  } catch (error) {
    let cleanupError: unknown
    const uncertain = error instanceof InFlightQueryUncertain || connectionFailure(error)
    if (!uncertain && (acquired.length > 0 || lockTimeoutConfigured)) {
      try {
        await cleanupCredentialLockState(
          client,
          monitor,
          acquired,
          lockTimeoutConfigured,
          queryTimeoutMs,
        )
      } catch (cleanupFailure) {
        cleanupError = cleanupFailure
      }
    }
    const reported =
      error instanceof InFlightQueryUncertain
        ? error.publicError
        : connectionFailure(error)
          ? new CoordinationError('uow.connection-lost')
          : lockTimeout(error)
            ? new CoordinationError('uow.lock-timeout')
            : errorForHostClose(error)
    try {
      await closeOwnedClient(
        monitor.error() ??
          (uncertain
            ? reported
            : cleanupError
              ? errorForHostClose(cleanupError)
              : undefined),
      )
    } catch {
      // The acquisition failure remains the stable public outcome; close was still attempted.
    }
    throw reported
  }

  return {
    client,
    connectionError: monitor.error,
    subscribeConnectionError: monitor.subscribe,
    async close(destroyError) {
      let cleanupError: unknown
      if (!destroyError() && !monitor.error()) {
        try {
          await cleanupCredentialLockState(
            client,
            monitor,
            acquired,
            true,
            queryTimeoutMs,
          )
        } catch (error) {
          cleanupError = error
        }
      }
      const destructionCause = destroyError() ?? monitor.error()
      await closeOwnedClient(
        destructionCause ??
          (cleanupError === undefined ? undefined : errorForHostClose(cleanupError)),
      )
      if (cleanupError !== undefined && destructionCause === undefined) {
        throw cleanupError
      }
    },
  }
}

const prelockedConstructionToken = Object.freeze({})

type IntentState<Operation extends PrelockedSessionOperation> = {
  consumed: boolean
  readonly operation: Operation
  readonly authorityScope: PlatformMutationAuthorityScope
}

const intentStates = new WeakMap<object, IntentState<PrelockedSessionOperation>>()

class PlatformPrelockedSessionIntent<
  Operation extends PrelockedSessionOperation,
> extends PrelockedSessionIntent<Operation> {
  constructor(
    token: typeof prelockedConstructionToken,
    operation: Operation,
    authorityScope: PlatformMutationAuthorityScope,
  ) {
    super()
    if (token !== prelockedConstructionToken) {
      throw new CoordinationError('uow.prelocked-session-invalid')
    }
    intentStates.set(this, { consumed: false, operation, authorityScope })
  }
}

function consumeIntent<Operation extends PrelockedSessionOperation>(
  intent: PrelockedSessionIntent<Operation>,
): {
  readonly operation: Operation
  readonly authorityScope: PlatformMutationAuthorityScope
} {
  const state = intentStates.get(intent) as IntentState<Operation> | undefined
  if (!state || state.consumed) {
    throw new CoordinationError('uow.prelocked-session-invalid')
  }
  state.consumed = true
  return {
    operation: state.operation,
    authorityScope: state.authorityScope,
  }
}

type LeaseState<Operation extends PrelockedSessionOperation> = {
  active: boolean
  inUnitOfWork: boolean
  readonly operation: Operation
  readonly session: AcquiredPrelockedSession
  readonly authorityScope: PlatformMutationAuthorityScope
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
  emailSignIn(
    issued: IssuedCredentialLifecycle<'email-sign-in'>,
  ): PrelockedSessionIntent<'email-sign-in'>
  memberResetRedemption(
    issued: IssuedCredentialLifecycle<'member-reset-redemption'>,
  ): PrelockedSessionIntent<'member-reset-redemption'>
  ownerRecoveryWebRedemption(
    issued: IssuedCredentialLifecycle<'owner-recovery-web-redemption'>,
  ): PrelockedSessionIntent<'owner-recovery-web-redemption'>
  bootstrapIssuance(
    issued: IssuedHostBootstrap<'issuance'>,
  ): PrelockedSessionIntent<'bootstrap-issuance'>
  bootstrapRedemption(
    issued: IssuedHostBootstrap<'redemption'>,
  ): PrelockedSessionIntent<'bootstrap-redemption'>
  checkedSignOut(
    issued: IssuedCredentialLifecycle<'checked-sign-out'>,
  ): PrelockedSessionIntent<'checked-sign-out'>
  expiredSessionMaintenance(
    issued: IssuedExpiredSessionMaintenance,
  ): PrelockedSessionIntent<'expired-session-maintenance'>
  instanceReset(
    issued: IssuedDestructiveAttempt<'instance-reset'>,
  ): PrelockedSessionIntent<'instance-reset'>
  localUserCreate(
    issued: IssuedDestructiveAttempt<'local-user-create'>,
  ): PrelockedSessionIntent<'local-user-create'>
  memberResetIssue(
    issued: IssuedDestructiveAttempt<'member-reset-issue'>,
  ): PrelockedSessionIntent<'member-reset-issue'>
  ownerRecoveryCliRedemption(
    issued: IssuedCredentialLifecycle<'owner-recovery-cli-redemption'>,
  ): PrelockedSessionIntent<'owner-recovery-cli-redemption'>
  ownerRecoveryIssue(
    issued: IssuedOwnerRecovery,
  ): PrelockedSessionIntent<'owner-recovery-issue'>
  subjectDeletion(
    issued: IssuedDestructiveAttempt<'trainee-data-deletion'>,
  ): PrelockedSessionIntent<'subject-deletion'>
}

function intent<Operation extends PrelockedSessionOperation>(
  operation: Operation,
  issued: IssuedMutationAuthority<MutationAuthority>,
): PrelockedSessionIntent<Operation> {
  const authorityScope = bindPlatformMutationAuthorityScope(issued, operation)
  return new PlatformPrelockedSessionIntent(
    prelockedConstructionToken,
    operation,
    authorityScope,
  )
}

/** Explicit named methods prevent callers from promoting a string to a trusted operation. */
export function createPlatformPrelockedSessionIntentFactory(): PlatformPrelockedSessionIntentFactory {
  return {
    emailSignIn: (issued) => intent('email-sign-in', issued),
    memberResetRedemption: (issued) => intent('member-reset-redemption', issued),
    ownerRecoveryWebRedemption: (issued) =>
      intent('owner-recovery-web-redemption', issued),
    bootstrapIssuance: (issued) => intent('bootstrap-issuance', issued),
    bootstrapRedemption: (issued) => intent('bootstrap-redemption', issued),
    checkedSignOut: (issued) => intent('checked-sign-out', issued),
    expiredSessionMaintenance: (issued) => intent('expired-session-maintenance', issued),
    instanceReset: (issued) => intent('instance-reset', issued),
    localUserCreate: (issued) => intent('local-user-create', issued),
    memberResetIssue: (issued) => intent('member-reset-issue', issued),
    ownerRecoveryCliRedemption: (issued) =>
      intent('owner-recovery-cli-redemption', issued),
    ownerRecoveryIssue: (issued) => intent('owner-recovery-issue', issued),
    subjectDeletion: (issued) => intent('subject-deletion', issued),
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
  authorityScope: PlatformMutationAuthorityScope | null,
): ResolvedPlatformPrelockedSession {
  const state = leaseState(lease)
  assertPlatformMutationAuthorityScope(
    authorityScope,
    state.authorityScope,
    expectedOperation,
  )
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
  readonly #externalHostConnection: PlatformExternalHostConnection | undefined
  readonly #lockTimeoutMs: number
  readonly #queryTimeoutMs: number

  constructor(
    detachedDrainTimeoutMs: number,
    externalHostConnection: PlatformExternalHostConnection | undefined,
    lockTimeoutMs: number,
    queryTimeoutMs: number,
  ) {
    this.#detachedDrainTimeoutMs = detachedDrainTimeoutMs
    this.#externalHostConnection = externalHostConnection
    this.#lockTimeoutMs = lockTimeoutMs
    this.#queryTimeoutMs = queryTimeoutMs
  }

  async withPrelockedSessionLease<Operation extends PrelockedSessionOperation, Result>(
    intentValue: PrelockedSessionIntent<Operation>,
    callback: (lease: PrelockedSessionLease<Operation>) => Promise<Result>,
    options: PrelockedSessionOptions = {},
  ): Promise<Result> {
    const captured = consumeIntent(intentValue)
    if (options.signal?.aborted) {
      revokePlatformMutationAuthorityScope(captured.authorityScope)
      throw new CoordinationError('uow.cancelled')
    }
    let session: AcquiredPrelockedSession
    try {
      session = await acquirePrelockedSession(
        captured.authorityScope,
        this.#externalHostConnection,
        options,
        this.#lockTimeoutMs,
        this.#queryTimeoutMs,
      )
    } catch (error) {
      revokePlatformMutationAuthorityScope(captured.authorityScope)
      throw error
    }
    if (options.signal?.aborted) {
      const error = new CoordinationError('uow.cancelled')
      try {
        await session.close(() => error)
      } finally {
        revokePlatformMutationAuthorityScope(captured.authorityScope)
      }
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
      revokePlatformMutationAuthorityScope(state.authorityScope)
      state.currentExecution?.abortController.abort(error)
      rejectLeaseFailure(new CoordinationError('uow.connection-lost'))
    }
    state = {
      active: true,
      inUnitOfWork: false,
      operation: captured.operation,
      session,
      authorityScope: captured.authorityScope,
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
      revokePlatformMutationAuthorityScope(state.authorityScope)
      state.currentExecution?.abortController.abort(cancellationError)
      rejectCancellation(cancellationError)
    }
    const unsubscribeConnectionError = session.subscribeConnectionError(onConnectionError)
    options.signal?.addEventListener('abort', onCancellation, { once: true })
    const lease = new PlatformPrelockedSessionLease(prelockedConstructionToken, state)
    this.#activeScopes += 1
    let outcome:
      | { readonly ok: true; readonly value: Result }
      | { readonly ok: false; readonly error: unknown }
    try {
      try {
        outcome = state.destroyError
          ? { ok: false, error: new CoordinationError('uow.connection-lost') }
          : {
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
      unsubscribeConnectionError()
      options.signal?.removeEventListener('abort', onCancellation)
      this.#activeScopes -= 1
      revokePlatformMutationAuthorityScope(captured.authorityScope)
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
  options: {
    readonly detachedDrainTimeoutMs?: number
    readonly externalHostConnection?: PlatformExternalHostConnection
    readonly lockTimeoutMs?: number
    readonly queryTimeoutMs?: number
  } = {},
): PrelockedSessionPort {
  const detachedDrainTimeoutMs = options.detachedDrainTimeoutMs ?? 250
  const lockTimeoutMs = options.lockTimeoutMs ?? 5_000
  const queryTimeoutMs = options.queryTimeoutMs ?? 30_000
  for (const [label, value] of [
    ['detached drain', detachedDrainTimeoutMs],
    ['lock', lockTimeoutMs],
    ['query', queryTimeoutMs],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`Prelocked-session ${label} timeout must be positive.`)
    }
  }
  return new PlatformPrelockedSessionPort(
    detachedDrainTimeoutMs,
    options.externalHostConnection,
    lockTimeoutMs,
    queryTimeoutMs,
  )
}
