import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  ContentLockedUnitOfWorkExecution,
  ContentLockIssuanceScope,
  type ContentLockOwnerSlot,
  type ContentLockPlanBindings,
  type ContentLockPlanEnvelope,
  type ContentLockPlanPort,
  type ContentLockPlanShape,
  ContentLockSourceProjection,
  ContentLockTransactionScope,
  CoordinationError,
  ExactReplayAuthorizer,
  type IssuanceContentLockSourceProjection,
  LockedContentPlanAttestor,
  NewCommandAuthorizer,
  PreparedContentLockPlan,
  type TransactionContentLockSourceProjection,
  type UnitOfWorkRequest,
  VerifiedContentLockPlan,
} from '@/application/coordination'
import type {
  ContentLockProjectionFactory,
  ContentReleaseCoordinate,
} from '@/application/coordination/content-lock-infrastructure'
import { type CanonicalValue, canonicalStringify } from '@/shared/canonical-json'
import {
  installationMutationEpochWireValue,
  subjectDataGenerationWireValue,
} from './lifecycle-values'

const planVersion = 'content-lock-plan-v1'
const signingDomain = 'indigo-content-lock-plan-v1\0'
const epochCommitmentDomain = 'indigo-content-lock-plan-epoch-v1\0'
const generationCommitmentDomain = 'indigo-content-lock-plan-generation-v1\0'
export const maximumContentLockPlanEnvelopeBytes = 16 * 1024
const maximumEnvelopeBytes = maximumContentLockPlanEnvelopeBytes
const maximumCorrectionKeys = 64
const base64urlPattern = /^[A-Za-z0-9_-]+$/
const contentLockPlanShapes = [
  'none',
  'release-revocation',
  'current-publication.initial',
  'current-publication.existing',
  'stale-regeneration',
  'correction-closure',
] as const satisfies readonly ContentLockPlanShape[]

type PlanSlot = {
  readonly ownerSlot: ContentLockOwnerSlot
  readonly keys: readonly string[]
}

type PlanPayload = {
  readonly version: typeof planVersion
  readonly shape: ContentLockPlanShape
  readonly purpose: string
  readonly actorAccountId: string
  readonly subjectId: string | null
  readonly formOrCommandId: string
  readonly sourceEntityIds: readonly string[]
  readonly epochCommitment: string
  readonly generationCommitment: string | null
  readonly slots: readonly PlanSlot[]
  readonly keys: readonly string[]
}

type ScopeState = {
  active: boolean
  readonly bindings: ContentLockPlanBindings
}

const contentConstructionToken = Object.freeze({})
const issuanceScopeStates = new WeakMap<object, ScopeState>()
const transactionScopeStates = new WeakMap<object, ScopeState>()

type VerifiedPlanChildState = {
  readonly abortController: AbortController
  consumed: PlatformConsumedContentLockPlan | undefined
  execution: PlatformContentLockedUnitOfWorkExecution<unknown> | undefined
}

class PlatformContentLockIssuanceScope extends ContentLockIssuanceScope {
  constructor(token: typeof contentConstructionToken, bindings: ContentLockPlanBindings) {
    super()
    if (token !== contentConstructionToken) throw invalidPlan()
    issuanceScopeStates.set(this, { active: true, bindings })
  }
}

function issuanceScopeState(scope: ContentLockIssuanceScope): ScopeState {
  const state = issuanceScopeStates.get(scope)
  if (!state) throw new CoordinationError('uow.scope-revoked')
  return state
}

class PlatformContentLockTransactionScope extends ContentLockTransactionScope {
  constructor(token: typeof contentConstructionToken, bindings: ContentLockPlanBindings) {
    super()
    if (token !== contentConstructionToken) throw invalidPlan()
    transactionScopeStates.set(this, { active: true, bindings })
  }
}

function transactionScopeState(scope: ContentLockTransactionScope): ScopeState {
  const state = transactionScopeStates.get(scope)
  if (!state) throw new CoordinationError('uow.scope-revoked')
  return state
}

type ProjectionData = {
  readonly phase: 'issuance' | 'transaction'
  readonly ownerSlot: ContentLockOwnerSlot
  readonly scopeState: ScopeState
  readonly keys: readonly string[]
}

const projectionStates = new WeakMap<object, ProjectionData>()

class PlatformContentLockProjection<
  Phase extends 'issuance' | 'transaction',
  Slot extends ContentLockOwnerSlot,
> extends ContentLockSourceProjection<Phase, Slot> {
  constructor(
    token: typeof contentConstructionToken,
    phase: Phase,
    ownerSlot: Slot,
    scopeState: ScopeState,
    keys: readonly string[],
  ) {
    super()
    if (token !== contentConstructionToken) throw invalidPlan()
    projectionStates.set(this, { phase, ownerSlot, scopeState, keys })
  }
}

type PreparedPlanState = { consumed: boolean; readonly payload: PlanPayload }
const preparedPlanStates = new WeakMap<object, PreparedPlanState>()

class PlatformPreparedContentLockPlan extends PreparedContentLockPlan {
  constructor(token: typeof contentConstructionToken, payload: PlanPayload) {
    super()
    if (token !== contentConstructionToken) throw invalidPlan()
    preparedPlanStates.set(this, { consumed: false, payload })
  }
}

function preparedPlanState(prepared: PreparedContentLockPlan): PreparedPlanState {
  const state = preparedPlanStates.get(prepared)
  if (!state || state.consumed) throw invalidPlan()
  return state
}

type VerifiedPlanState = {
  active: boolean
  consumed: boolean
  readonly payload: PlanPayload
  readonly bindings: ContentLockPlanBindings
  readonly child: VerifiedPlanChildState
}

const verifiedPlanStates = new WeakMap<object, VerifiedPlanState>()

class PlatformVerifiedContentLockPlan<
  Shape extends ContentLockPlanShape,
> extends VerifiedContentLockPlan<Shape> {
  constructor(
    token: typeof contentConstructionToken,
    payload: PlanPayload & { readonly shape: Shape },
    bindings: ContentLockPlanBindings & { readonly shape: Shape },
  ) {
    super()
    if (token !== contentConstructionToken) throw invalidPlan()
    verifiedPlanStates.set(this, {
      active: true,
      consumed: false,
      payload,
      bindings,
      child: {
        abortController: new AbortController(),
        consumed: undefined,
        execution: undefined,
      },
    })
  }
}

function verifiedPlanState(plan: VerifiedContentLockPlan): VerifiedPlanState {
  const state = verifiedPlanStates.get(plan)
  if (!state) throw new CoordinationError('uow.scope-revoked')
  return state
}

type ExecutionState<Result> = {
  readonly plan: VerifiedContentLockPlan
  readonly promise: Promise<Result>
}

const executionStates = new WeakMap<object, ExecutionState<unknown>>()

class PlatformContentLockedUnitOfWorkExecution<
  Result,
> extends ContentLockedUnitOfWorkExecution<Result> {
  constructor(
    token: typeof contentConstructionToken,
    plan: VerifiedContentLockPlan,
    promise: Promise<Result>,
  ) {
    super()
    if (token !== contentConstructionToken) {
      throw new CoordinationError('uow.scope-revoked')
    }
    executionStates.set(this, { plan, promise } as ExecutionState<unknown>)
  }

  // biome-ignore lint/suspicious/noThenProperty: this exact nominal execution is joined by the plan scope
  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const state = executionStates.get(this) as ExecutionState<Result> | undefined
    if (!state) return Promise.reject(new CoordinationError('uow.scope-revoked'))
    return state.promise.then(onfulfilled, onrejected)
  }
}

function consumeVerifiedPlan(plan: VerifiedContentLockPlan): {
  readonly payload: PlanPayload
  readonly bindings: ContentLockPlanBindings
} {
  const state = verifiedPlanState(plan)
  if (!state.active || state.consumed) {
    throw new CoordinationError('uow.scope-revoked')
  }
  state.consumed = true
  return { payload: state.payload, bindings: state.bindings }
}

function registerConsumedPlan(
  plan: VerifiedContentLockPlan,
  consumed: PlatformConsumedContentLockPlan,
): void {
  const state = verifiedPlanState(plan)
  if (!state.active || state.child.consumed) {
    throw new CoordinationError('uow.scope-revoked')
  }
  state.child.consumed = consumed
}

function registerPlanExecution<Result>(
  plan: VerifiedContentLockPlan,
  execution: PlatformContentLockedUnitOfWorkExecution<Result>,
): void {
  const state = verifiedPlanState(plan)
  if (!state.active || !state.consumed || state.child.execution) {
    throw new CoordinationError('uow.scope-revoked')
  }
  state.child.execution = execution as PlatformContentLockedUnitOfWorkExecution<unknown>
}

function revokeVerifiedPlan(plan: VerifiedContentLockPlan): void {
  const state = verifiedPlanState(plan)
  state.active = false
  state.child.abortController.abort()
  state.child.consumed?.revoke()
}

function planExecutionState<Result>(
  execution: ContentLockedUnitOfWorkExecution<Result>,
): ExecutionState<Result> | undefined {
  return executionStates.get(execution) as ExecutionState<Result> | undefined
}

type AttestorState = {
  readonly scopeState: ScopeState
  readonly expectedSlots: readonly PlanSlot[]
  active: boolean
  used: boolean
  attested: boolean
  exactReplayAuthorized: boolean
  exactReplayResult: unknown
  exactReplayResultFingerprint: string | typeof noExactReplayResult
  newCommandAuthorized: boolean
  writeAuthorized: boolean
}

const attestorStates = new WeakMap<object, AttestorState>()
const noExactReplayResult = Symbol('no-exact-replay-result')

function replayResultFingerprint(value: unknown): string {
  const ancestors = new WeakSet<object>()
  let nodeCount = 0
  const capture = (candidate: unknown, depth: number): CanonicalValue => {
    nodeCount += 1
    if (depth > 64 || nodeCount > 100_000) {
      throw new TypeError('The stored replay result is too complex.')
    }
    if (
      candidate === null ||
      typeof candidate === 'string' ||
      typeof candidate === 'boolean'
    ) {
      return candidate
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new TypeError('Invalid replay number.')
      return candidate
    }
    if (typeof candidate !== 'object') throw new TypeError('Invalid replay value.')
    if (ancestors.has(candidate)) throw new TypeError('Cyclic replay result.')
    ancestors.add(candidate)
    try {
      const descriptors = Object.getOwnPropertyDescriptors(candidate)
      if (Array.isArray(candidate)) {
        const length = descriptors.length
        if (
          !length ||
          !('value' in length) ||
          !Number.isSafeInteger(length.value) ||
          length.value < 0 ||
          length.value > 100_000
        ) {
          throw new TypeError('Invalid replay array.')
        }
        const result = new Array<CanonicalValue>(length.value)
        for (const key of Reflect.ownKeys(descriptors)) {
          if (key === 'length') continue
          if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key)) {
            throw new TypeError('Invalid replay array property.')
          }
          const index = Number(key)
          const descriptor = descriptors[key]
          if (
            index >= result.length ||
            !descriptor ||
            !descriptor.enumerable ||
            !('value' in descriptor)
          ) {
            throw new TypeError('Invalid replay array entry.')
          }
          result[index] = capture(descriptor.value, depth + 1)
        }
        for (let index = 0; index < result.length; index += 1) {
          if (!Object.hasOwn(descriptors, String(index))) {
            throw new TypeError('Sparse replay array.')
          }
        }
        return result
      }

      const prototype = Reflect.getPrototypeOf(candidate)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Replay results must be plain JSON objects.')
      }
      const result = Object.create(null) as Record<string, CanonicalValue>
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') throw new TypeError('Invalid replay object key.')
        const descriptor = descriptors[key]
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new TypeError('Invalid replay object property.')
        }
        result[key] = capture(descriptor.value, depth + 1)
      }
      return result
    } finally {
      ancestors.delete(candidate)
    }
  }

  try {
    return canonicalStringify(capture(value, 0))
  } catch {
    throw new CoordinationError('uow.scope-revoked')
  }
}

class PlatformLockedContentPlanAttestor extends LockedContentPlanAttestor {
  constructor(
    token: typeof contentConstructionToken,
    scopeState: ScopeState,
    expectedSlots: readonly PlanSlot[],
  ) {
    super()
    if (token !== contentConstructionToken) throw invalidPlan()
    attestorStates.set(this, {
      scopeState,
      expectedSlots,
      active: true,
      used: false,
      attested: false,
      exactReplayAuthorized: false,
      exactReplayResult: noExactReplayResult,
      exactReplayResultFingerprint: noExactReplayResult,
      newCommandAuthorized: false,
      writeAuthorized: false,
    })
  }

  assertCurrentLockedContentSet(
    fragments: readonly TransactionContentLockSourceProjection[],
  ): void {
    const state = attestorState(this)
    if (
      !state.active ||
      !state.scopeState.active ||
      state.used ||
      state.exactReplayAuthorized ||
      !state.newCommandAuthorized
    ) {
      throw new CoordinationError('uow.scope-revoked')
    }
    state.used = true

    let slots: readonly PlanSlot[]
    try {
      slots = projectionsToSlots(fragments, 'transaction', state.scopeState)
    } catch {
      throw new CoordinationError('content-lock-plan.stale')
    }
    if (!sameSlots(slots, state.expectedSlots)) {
      throw new CoordinationError('content-lock-plan.stale')
    }
    state.attested = true
  }
}

function attestorState(attestor: LockedContentPlanAttestor): AttestorState {
  const state = attestorStates.get(attestor)
  if (!state) throw new CoordinationError('uow.scope-revoked')
  return state
}

function assertAttestorReadyToCommit(
  attestor: LockedContentPlanAttestor,
  callbackResult: unknown,
): void {
  const state = attestorState(attestor)
  if (!state.active || !state.scopeState.active) {
    throw new CoordinationError('uow.scope-revoked')
  }
  if (
    !state.exactReplayAuthorized &&
    (!state.newCommandAuthorized || (state.expectedSlots.length > 0 && !state.attested))
  ) {
    throw new CoordinationError('content-lock-plan.stale')
  }
  if (
    state.exactReplayAuthorized &&
    (!Object.is(state.exactReplayResult, callbackResult) ||
      state.exactReplayResultFingerprint !== replayResultFingerprint(callbackResult))
  ) {
    throw new CoordinationError('uow.scope-revoked')
  }
}

function assertAttestorWriteAuthorized(attestor: LockedContentPlanAttestor): void {
  const state = attestorState(attestor)
  if (!state.active || !state.scopeState.active) {
    throw new CoordinationError('uow.scope-revoked')
  }
  if (
    state.exactReplayAuthorized ||
    !state.newCommandAuthorized ||
    (state.expectedSlots.length > 0 && !state.attested)
  ) {
    throw new CoordinationError('content-lock-plan.stale')
  }
  state.writeAuthorized = true
}

function authorizeAttestorExactReplay(
  attestor: LockedContentPlanAttestor,
  storedResult: unknown,
): void {
  const state = attestorState(attestor)
  if (
    !state.active ||
    !state.scopeState.active ||
    state.used ||
    state.attested ||
    state.exactReplayAuthorized ||
    state.newCommandAuthorized ||
    state.writeAuthorized
  ) {
    throw new CoordinationError('uow.scope-revoked')
  }
  const fingerprint = replayResultFingerprint(storedResult)
  state.exactReplayAuthorized = true
  state.exactReplayResult = storedResult
  state.exactReplayResultFingerprint = fingerprint
}

function authorizeAttestorNewCommand(attestor: LockedContentPlanAttestor): void {
  const state = attestorState(attestor)
  if (
    !state.active ||
    !state.scopeState.active ||
    state.used ||
    state.attested ||
    state.exactReplayAuthorized ||
    state.newCommandAuthorized ||
    state.writeAuthorized
  ) {
    throw new CoordinationError('uow.scope-revoked')
  }
  state.newCommandAuthorized = true
}

function revokeAttestor(attestor: LockedContentPlanAttestor): void {
  const state = attestorState(attestor)
  state.active = false
  state.scopeState.active = false
}

type CommandAuthorizerState = {
  readonly attestor: LockedContentPlanAttestor
  active: boolean
}

const exactReplayAuthorizerStates = new WeakMap<object, CommandAuthorizerState>()
const newCommandAuthorizerStates = new WeakMap<object, CommandAuthorizerState>()

class PlatformExactReplayAuthorizer extends ExactReplayAuthorizer {
  constructor(
    token: typeof contentConstructionToken,
    attestor: PlatformLockedContentPlanAttestor,
  ) {
    super()
    if (token !== contentConstructionToken) throw invalidPlan()
    exactReplayAuthorizerStates.set(this, { attestor, active: false })
  }

  authorizeExactReplay(storedResult: unknown): void {
    const state = exactReplayAuthorizerStates.get(this)
    if (!state?.active) throw new CoordinationError('uow.scope-revoked')
    authorizeAttestorExactReplay(state.attestor, storedResult)
  }
}

function activateExactReplayAuthorizer(authorizer: ExactReplayAuthorizer): void {
  const state = exactReplayAuthorizerStates.get(authorizer)
  if (!state) throw new CoordinationError('uow.scope-revoked')
  state.active = true
}

class PlatformNewCommandAuthorizer extends NewCommandAuthorizer {
  constructor(
    token: typeof contentConstructionToken,
    attestor: PlatformLockedContentPlanAttestor,
  ) {
    super()
    if (token !== contentConstructionToken) throw invalidPlan()
    newCommandAuthorizerStates.set(this, { attestor, active: false })
  }

  authorizeNewCommand(): void {
    const state = newCommandAuthorizerStates.get(this)
    if (!state?.active) throw new CoordinationError('uow.scope-revoked')
    authorizeAttestorNewCommand(state.attestor)
  }
}

function activateNewCommandAuthorizer(authorizer: NewCommandAuthorizer): void {
  const state = newCommandAuthorizerStates.get(authorizer)
  if (!state) throw new CoordinationError('uow.scope-revoked')
  state.active = true
}

export type ConsumedContentLockPlan = {
  readonly lockKeys: readonly string[]
  readonly transactionScope: ContentLockTransactionScope
  readonly attestor: LockedContentPlanAttestor
  readonly exactReplayAuthorizer: ExactReplayAuthorizer
  readonly newCommandAuthorizer: NewCommandAuthorizer
  readonly signal: AbortSignal
  assertActive(): void
  assertReadyToCommit(callbackResult: unknown): void
  assertWriteAuthorized(): void
  activateCommandAuthorizers(): void
  finish(): void
}

class PlatformConsumedContentLockPlan implements ConsumedContentLockPlan {
  readonly lockKeys: readonly string[]
  readonly transactionScope: ContentLockTransactionScope
  readonly attestor: PlatformLockedContentPlanAttestor
  readonly exactReplayAuthorizer: PlatformExactReplayAuthorizer
  readonly newCommandAuthorizer: PlatformNewCommandAuthorizer
  readonly signal: AbortSignal
  #active = true

  constructor(input: {
    readonly token: typeof contentConstructionToken
    readonly abortController: AbortController
    readonly attestor: PlatformLockedContentPlanAttestor
    readonly lockKeys: readonly string[]
    readonly transactionScope: ContentLockTransactionScope
  }) {
    if (input.token !== contentConstructionToken) throw invalidPlan()
    this.lockKeys = input.lockKeys
    this.transactionScope = input.transactionScope
    this.attestor = input.attestor
    this.exactReplayAuthorizer = new PlatformExactReplayAuthorizer(
      contentConstructionToken,
      input.attestor,
    )
    this.newCommandAuthorizer = new PlatformNewCommandAuthorizer(
      contentConstructionToken,
      input.attestor,
    )
    this.signal = input.abortController.signal
  }

  assertActive(): void {
    if (!this.#active || this.signal.aborted) {
      throw new CoordinationError('uow.scope-revoked')
    }
  }

  assertReadyToCommit(callbackResult: unknown): void {
    this.assertActive()
    assertAttestorReadyToCommit(this.attestor, callbackResult)
  }

  assertWriteAuthorized(): void {
    this.assertActive()
    assertAttestorWriteAuthorized(this.attestor)
  }

  activateCommandAuthorizers(): void {
    this.assertActive()
    activateExactReplayAuthorizer(this.exactReplayAuthorizer)
    activateNewCommandAuthorizer(this.newCommandAuthorizer)
  }

  finish(): void {
    this.revoke()
  }

  revoke(): void {
    if (!this.#active) return
    this.#active = false
    revokeAttestor(this.attestor)
  }
}

export type PlatformContentLockPlanOptions = {
  readonly authSecret: string
  readonly resolveActorAccountId: () => Promise<string>
}

function invalidPlan(): CoordinationError {
  return new CoordinationError('content-lock-plan.invalid')
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort(compareBytes)
  const sortedExpected = [...expected].sort(compareBytes)
  if (!sameStrings(actual, sortedExpected)) throw invalidPlan()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function isStrictlySorted(values: readonly string[]): boolean {
  return values.every((value, index) => {
    const previous = values[index - 1]
    return previous === undefined || compareBytes(previous, value) < 0
  })
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  )
}

function sameSlots(left: readonly PlanSlot[], right: readonly PlanSlot[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (slot, index) =>
        slot.ownerSlot === right[index]?.ownerSlot &&
        sameStrings(slot.keys, right[index]?.keys ?? []),
    )
  )
}

function assertBindingString(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 300 ||
    hasControlCharacter(value)
  ) {
    throw invalidPlan()
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 31 || code === 127
  })
}

function assertCanonicalStringArray(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value)) throw invalidPlan()
  for (const entry of value) assertBindingString(entry)
  if (!isStrictlySorted(value)) throw invalidPlan()
}

function assertCanonicalKeyArray(value: unknown): asserts value is readonly string[] {
  assertCanonicalStringArray(value)
  for (const key of value) parseCoordinateKey(key)
}

function assertBindings(bindings: ContentLockPlanBindings): void {
  if (!(contentLockPlanShapes as readonly unknown[]).includes(bindings.shape)) {
    throw invalidPlan()
  }
  assertBindingString(bindings.purpose)
  assertBindingString(bindings.actorAccountId)
  if (bindings.subjectId !== null) assertBindingString(bindings.subjectId)
  assertBindingString(bindings.formOrCommandId)
  assertCanonicalStringArray(bindings.sourceEntityIds)
  installationMutationEpochWireValue(bindings.expectedEpoch)
  if (bindings.expectedGeneration !== null) {
    subjectDataGenerationWireValue(bindings.expectedGeneration)
  }
}

function immutableBindings<Bindings extends ContentLockPlanBindings>(
  bindings: Bindings,
): Bindings {
  if (bindings === null || typeof bindings !== 'object') throw invalidPlan()
  const descriptors = Object.getOwnPropertyDescriptors(bindings)
  const expectedKeys = [
    'actorAccountId',
    'expectedEpoch',
    'expectedGeneration',
    'formOrCommandId',
    'purpose',
    'shape',
    'sourceEntityIds',
    'subjectId',
  ]
  if (
    Reflect.ownKeys(descriptors).some(
      (property) => typeof property !== 'string' || !expectedKeys.includes(property),
    ) ||
    expectedKeys.some((property) => {
      const descriptor = descriptors[property]
      return !descriptor || !('value' in descriptor)
    })
  ) {
    throw invalidPlan()
  }
  const value = (property: string): unknown => descriptors[property]?.value
  const sourceEntityIds = value('sourceEntityIds')
  if (!Array.isArray(sourceEntityIds)) throw invalidPlan()
  const sourceDescriptors = Object.getOwnPropertyDescriptors(sourceEntityIds)
  const length = Reflect.get(sourceDescriptors, 'length') as
    | PropertyDescriptor
    | undefined
  if (
    !length ||
    !('value' in length) ||
    typeof length.value !== 'number' ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0 ||
    length.value > maximumEnvelopeBytes
  ) {
    throw invalidPlan()
  }
  const capturedSources = new Array<string>(length.value)
  for (const property of Reflect.ownKeys(sourceDescriptors)) {
    if (property === 'length') continue
    if (typeof property !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(property)) {
      throw invalidPlan()
    }
    const index = Number(property)
    const descriptor = Reflect.get(sourceDescriptors, property) as
      | PropertyDescriptor
      | undefined
    if (index >= capturedSources.length || !descriptor || !('value' in descriptor)) {
      throw invalidPlan()
    }
    capturedSources[index] = descriptor.value as string
  }
  for (let index = 0; index < capturedSources.length; index += 1) {
    if (!Object.hasOwn(sourceDescriptors, String(index))) throw invalidPlan()
  }
  return Object.freeze({
    shape: value('shape'),
    purpose: value('purpose'),
    actorAccountId: value('actorAccountId'),
    subjectId: value('subjectId'),
    formOrCommandId: value('formOrCommandId'),
    sourceEntityIds: Object.freeze(capturedSources),
    expectedEpoch: value('expectedEpoch'),
    expectedGeneration: value('expectedGeneration'),
  }) as Bindings
}

function coordinateKey(coordinate: ContentReleaseCoordinate): string {
  if (
    (coordinate.kind !== 'methodology' && coordinate.kind !== 'template') ||
    !isCoordinatePart(coordinate.id) ||
    !isCoordinatePart(coordinate.version)
  ) {
    throw invalidPlan()
  }
  return `${coordinate.kind}:${coordinate.id}:${coordinate.version}`
}

function isCoordinatePart(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 200 &&
    !value.includes(':') &&
    !/\s/.test(value) &&
    !hasControlCharacter(value)
  )
}

function parseCoordinateKey(key: string): void {
  const [kind, id, version, extra] = key.split(':')
  if (
    extra !== undefined ||
    (kind !== 'methodology' && kind !== 'template') ||
    !id ||
    !version ||
    !isCoordinatePart(id) ||
    !isCoordinatePart(version)
  ) {
    throw invalidPlan()
  }
}

function canonicalCoordinateKeys(
  coordinates: readonly ContentReleaseCoordinate[],
): readonly string[] {
  const keys = coordinates.map(coordinateKey).sort(compareBytes)
  if (keys.some((key, index) => key === keys[index - 1])) throw invalidPlan()
  return keys
}

function projectionsToSlots(
  fragments: readonly (
    | IssuanceContentLockSourceProjection
    | TransactionContentLockSourceProjection
  )[],
  phase: 'issuance' | 'transaction',
  scopeState: ScopeState,
): readonly PlanSlot[] {
  const slots = fragments.map((fragment) => {
    const projection = projectionStates.get(fragment)
    if (!projection) throw invalidPlan()
    if (
      projection.phase !== phase ||
      projection.scopeState !== scopeState ||
      !scopeState.active
    ) {
      throw invalidPlan()
    }
    return { ownerSlot: projection.ownerSlot, keys: projection.keys }
  })
  slots.sort((left, right) => compareBytes(left.ownerSlot, right.ownerSlot))
  if (slots.some((slot, index) => slot.ownerSlot === slots[index - 1]?.ownerSlot)) {
    throw invalidPlan()
  }
  return slots
}

function hasExactPair(keys: readonly string[]): boolean {
  return (
    keys.length === 2 &&
    keys.some((key) => key.startsWith('methodology:')) &&
    keys.some((key) => key.startsWith('template:'))
  )
}

function containsMethodologyAndTemplate(keys: readonly string[]): boolean {
  return (
    keys.some((key) => key.startsWith('methodology:')) &&
    keys.some((key) => key.startsWith('template:'))
  )
}

function assertShape(
  shape: ContentLockPlanShape,
  slots: readonly PlanSlot[],
): readonly string[] {
  const expectedSlots: Readonly<
    Record<ContentLockPlanShape, readonly ContentLockOwnerSlot[]>
  > = {
    none: [],
    'release-revocation': ['methodology-target'],
    'current-publication.initial': ['methodology-target'],
    'current-publication.existing': ['programs-current'],
    'stale-regeneration': ['methodology-target', 'programs-current'],
    'correction-closure': ['programs-current', 'training-history'],
  }
  if (
    !sameStrings(
      slots.map(({ ownerSlot }) => ownerSlot),
      expectedSlots[shape],
    )
  ) {
    throw invalidPlan()
  }

  const keys = [...new Set(slots.flatMap((slot) => slot.keys))].sort(compareBytes)
  if (shape === 'none' && keys.length !== 0) throw invalidPlan()
  if (shape === 'release-revocation' && keys.length !== 1) throw invalidPlan()
  if (shape === 'current-publication.initial' && !hasExactPair(keys)) throw invalidPlan()
  if (shape === 'current-publication.existing' && !hasExactPair(keys)) throw invalidPlan()
  if (shape === 'stale-regeneration') {
    if (
      keys.length < 2 ||
      keys.length > 4 ||
      slots.some((slot) => !hasExactPair(slot.keys))
    ) {
      throw invalidPlan()
    }
  }
  if (shape === 'correction-closure') {
    const programs = slots.find(({ ownerSlot }) => ownerSlot === 'programs-current')
    const training = slots.find(({ ownerSlot }) => ownerSlot === 'training-history')
    if (!programs || !hasExactPair(programs.keys)) throw invalidPlan()
    if (!training || !containsMethodologyAndTemplate(training.keys)) throw invalidPlan()
    if (keys.length < 2) throw invalidPlan()
    if (keys.length > maximumCorrectionKeys) {
      throw new CoordinationError('content-lock-plan.too-large')
    }
  }
  return keys
}

function commitment(key: Buffer, domain: string, value: string): string {
  return createHmac('sha256', key)
    .update(domain, 'utf8')
    .update(value, 'utf8')
    .digest('base64url')
}

function payloadFor(
  key: Buffer,
  bindings: ContentLockPlanBindings,
  slots: readonly PlanSlot[],
): PlanPayload {
  const keys = assertShape(bindings.shape, slots)
  return {
    version: planVersion,
    shape: bindings.shape,
    purpose: bindings.purpose,
    actorAccountId: bindings.actorAccountId,
    subjectId: bindings.subjectId,
    formOrCommandId: bindings.formOrCommandId,
    sourceEntityIds: bindings.sourceEntityIds,
    epochCommitment: commitment(
      key,
      epochCommitmentDomain,
      installationMutationEpochWireValue(bindings.expectedEpoch),
    ),
    generationCommitment:
      bindings.expectedGeneration === null
        ? null
        : commitment(
            key,
            generationCommitmentDomain,
            subjectDataGenerationWireValue(bindings.expectedGeneration),
          ),
    slots,
    keys,
  }
}

function parsePayload(value: unknown): PlanPayload {
  if (!isRecord(value)) throw invalidPlan()
  assertExactKeys(value, [
    'version',
    'shape',
    'purpose',
    'actorAccountId',
    'subjectId',
    'formOrCommandId',
    'sourceEntityIds',
    'epochCommitment',
    'generationCommitment',
    'slots',
    'keys',
  ])
  if (value.version !== planVersion) throw invalidPlan()
  if (!(contentLockPlanShapes as readonly unknown[]).includes(value.shape)) {
    throw invalidPlan()
  }
  assertBindingString(value.purpose)
  assertBindingString(value.actorAccountId)
  if (value.subjectId !== null) assertBindingString(value.subjectId)
  assertBindingString(value.formOrCommandId)
  assertCanonicalStringArray(value.sourceEntityIds)
  if (
    typeof value.epochCommitment !== 'string' ||
    !base64urlPattern.test(value.epochCommitment)
  ) {
    throw invalidPlan()
  }
  if (
    value.generationCommitment !== null &&
    (typeof value.generationCommitment !== 'string' ||
      !base64urlPattern.test(value.generationCommitment))
  ) {
    throw invalidPlan()
  }
  assertCanonicalKeyArray(value.keys)
  if (!Array.isArray(value.slots)) throw invalidPlan()
  const slots = value.slots.map((slot): PlanSlot => {
    if (!isRecord(slot)) throw invalidPlan()
    assertExactKeys(slot, ['ownerSlot', 'keys'])
    if (
      !['methodology-target', 'programs-current', 'training-history'].includes(
        String(slot.ownerSlot),
      )
    ) {
      throw invalidPlan()
    }
    assertCanonicalKeyArray(slot.keys)
    return {
      ownerSlot: slot.ownerSlot as ContentLockOwnerSlot,
      keys: slot.keys,
    }
  })
  if (!isStrictlySorted(slots.map(({ ownerSlot }) => ownerSlot))) throw invalidPlan()

  const shape = value.shape as ContentLockPlanShape
  const derivedKeys = assertShape(shape, slots)
  if (!sameStrings(derivedKeys, value.keys)) throw invalidPlan()
  return {
    version: planVersion,
    shape,
    purpose: value.purpose,
    actorAccountId: value.actorAccountId,
    subjectId: value.subjectId,
    formOrCommandId: value.formOrCommandId,
    sourceEntityIds: value.sourceEntityIds,
    epochCommitment: value.epochCommitment,
    generationCommitment: value.generationCommitment,
    slots,
    keys: value.keys,
  }
}

function signature(key: Buffer, canonicalPayload: string): Buffer {
  return createHmac('sha256', key).update(canonicalPayload, 'utf8').digest()
}

function bindingsMatch(
  key: Buffer,
  payload: PlanPayload,
  bindings: ContentLockPlanBindings,
): boolean {
  const candidate = payloadFor(key, bindings, payload.slots)
  return (
    candidate.shape === payload.shape &&
    candidate.purpose === payload.purpose &&
    candidate.actorAccountId === payload.actorAccountId &&
    candidate.subjectId === payload.subjectId &&
    candidate.formOrCommandId === payload.formOrCommandId &&
    sameStrings(candidate.sourceEntityIds, payload.sourceEntityIds) &&
    candidate.epochCommitment === payload.epochCommitment &&
    candidate.generationCommitment === payload.generationCommitment
  )
}

function sameLifecycleBindings(
  left: ContentLockPlanBindings,
  right: ContentLockPlanBindings,
): boolean {
  const leftGeneration =
    left.expectedGeneration === null
      ? null
      : subjectDataGenerationWireValue(left.expectedGeneration)
  const rightGeneration =
    right.expectedGeneration === null
      ? null
      : subjectDataGenerationWireValue(right.expectedGeneration)
  return (
    left.shape === right.shape &&
    left.purpose === right.purpose &&
    left.actorAccountId === right.actorAccountId &&
    left.subjectId === right.subjectId &&
    left.formOrCommandId === right.formOrCommandId &&
    sameStrings(left.sourceEntityIds, right.sourceEntityIds) &&
    installationMutationEpochWireValue(left.expectedEpoch) ===
      installationMutationEpochWireValue(right.expectedEpoch) &&
    leftGeneration === rightGeneration
  )
}

function expectedShapeForRequest(request: UnitOfWorkRequest): ContentLockPlanShape {
  switch (request.operation) {
    case 'global-product-mutation':
    case 'subject-product-mutation':
      return 'none'
    case 'content-release-revocation':
      return 'release-revocation'
    case 'current-publication.initial':
    case 'current-publication.existing':
    case 'stale-regeneration':
    case 'correction-closure':
      return request.operation
    default:
      throw invalidPlan()
  }
}

function assertPlanMatchesRequest(
  plan: VerifiedContentLockPlan,
  bindings: ContentLockPlanBindings,
  request: UnitOfWorkRequest,
): void {
  if (
    request.content.kind !== 'verified' ||
    request.authority.kind !== 'authenticated-session' ||
    !('workflowPurpose' in request) ||
    request.content.plan !== plan
  ) {
    throw invalidPlan()
  }
  const requestBindings = request.content.bindings
  const subjectId = request.subjectLock?.subjectUserId ?? null
  if (
    !sameLifecycleBindings(bindings, requestBindings) ||
    bindings.shape !== expectedShapeForRequest(request) ||
    bindings.purpose !== request.workflowPurpose ||
    bindings.actorAccountId !== request.authority.actorUserId ||
    bindings.subjectId !== subjectId ||
    installationMutationEpochWireValue(bindings.expectedEpoch) !==
      installationMutationEpochWireValue(request.expectedEpoch)
  ) {
    throw invalidPlan()
  }
}

export function createContentLockProjectionFactory<Slot extends ContentLockOwnerSlot>(
  ownerSlot: Slot,
): ContentLockProjectionFactory<Slot> {
  return {
    ownerSlot,
    createIssuanceProjection(scope, coordinates) {
      const state = issuanceScopeState(scope)
      if (!state.active) throw new CoordinationError('uow.scope-revoked')
      return new PlatformContentLockProjection(
        contentConstructionToken,
        'issuance',
        ownerSlot,
        state,
        canonicalCoordinateKeys(coordinates),
      )
    },
    createTransactionProjection(scope, coordinates) {
      const state = transactionScopeState(scope)
      if (!state.active) throw new CoordinationError('uow.scope-revoked')
      return new PlatformContentLockProjection(
        contentConstructionToken,
        'transaction',
        ownerSlot,
        state,
        canonicalCoordinateKeys(coordinates),
      )
    },
  }
}

export function createContentLockPlanPort(
  options: PlatformContentLockPlanOptions,
): ContentLockPlanPort {
  if (options.authSecret.length < 32) {
    throw new TypeError(
      'Content lock signing requires the configured authentication secret.',
    )
  }
  const key = createHmac('sha256', options.authSecret)
    .update(signingDomain, 'utf8')
    .digest()
  let activeVerifiedScopes = 0

  return {
    prepareEnvelope(rawEnvelope) {
      if (
        typeof rawEnvelope !== 'string' ||
        Buffer.byteLength(rawEnvelope, 'utf8') > maximumEnvelopeBytes
      ) {
        throw invalidPlan()
      }
      const parts = rawEnvelope.split('.')
      if (
        parts.length !== 2 ||
        !parts[0] ||
        !parts[1] ||
        !base64urlPattern.test(parts[0]) ||
        !base64urlPattern.test(parts[1])
      ) {
        throw invalidPlan()
      }
      const payloadBytes = Buffer.from(parts[0], 'base64url')
      const suppliedSignature = Buffer.from(parts[1], 'base64url')
      if (
        payloadBytes.toString('base64url') !== parts[0] ||
        suppliedSignature.toString('base64url') !== parts[1]
      ) {
        throw invalidPlan()
      }
      const canonicalPayload = payloadBytes.toString('utf8')
      if (!Buffer.from(canonicalPayload, 'utf8').equals(payloadBytes)) {
        throw invalidPlan()
      }
      const expectedSignature = signature(key, canonicalPayload)
      if (
        suppliedSignature.length !== expectedSignature.length ||
        !timingSafeEqual(suppliedSignature, expectedSignature)
      ) {
        throw invalidPlan()
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(canonicalPayload)
      } catch {
        throw invalidPlan()
      }
      const payload = parsePayload(parsed)
      if (canonicalStringify(payload as unknown as CanonicalValue) !== canonicalPayload) {
        throw invalidPlan()
      }
      return new PlatformPreparedContentLockPlan(contentConstructionToken, payload)
    },

    async withVerifiedContentLockPlan<Shape extends ContentLockPlanShape, Result>(
      prepared: PreparedContentLockPlan,
      bindings: ContentLockPlanBindings & { readonly shape: Shape },
      callback: (
        plan: VerifiedContentLockPlan<Shape>,
      ) => ContentLockedUnitOfWorkExecution<Result>,
    ): Promise<Result> {
      const preparedState = preparedPlanState(prepared)
      preparedState.consumed = true
      const payload = preparedState.payload
      const capturedBindings = immutableBindings(bindings)
      const actorAccountId = await options.resolveActorAccountId()
      assertBindings(capturedBindings)
      if (
        !bindingsMatch(key, payload, capturedBindings) ||
        actorAccountId !== capturedBindings.actorAccountId ||
        actorAccountId !== payload.actorAccountId
      ) {
        throw invalidPlan()
      }
      const verified = new PlatformVerifiedContentLockPlan(
        contentConstructionToken,
        payload as PlanPayload & { readonly shape: typeof capturedBindings.shape },
        capturedBindings,
      )
      activeVerifiedScopes += 1
      try {
        let callbackOutcome:
          | {
              readonly ok: true
              readonly execution: ContentLockedUnitOfWorkExecution<Result>
            }
          | { readonly ok: false; readonly error: unknown }
        try {
          callbackOutcome = { ok: true, execution: callback(verified) }
        } catch (error) {
          callbackOutcome = { ok: false, error }
        }

        const child = verifiedPlanState(verified).child
        const returned = callbackOutcome.ok ? callbackOutcome.execution : undefined
        const returnedState = returned ? planExecutionState(returned) : undefined
        const exactExecution =
          returnedState?.plan === verified && child.execution === returned
        if (!exactExecution) {
          revokeVerifiedPlan(verified)
          if (child.execution) {
            await (
              planExecutionState(child.execution)?.promise ?? Promise.resolve()
            ).catch(() => undefined)
          }
          if (!callbackOutcome.ok) throw callbackOutcome.error
          if (child.execution) throw new CoordinationError('uow.detached-work')
          throw invalidPlan()
        }
        if (!callbackOutcome.ok) throw callbackOutcome.error
        if (!returnedState) throw new CoordinationError('uow.scope-revoked')
        return await returnedState.promise
      } finally {
        revokeVerifiedPlan(verified)
        activeVerifiedScopes -= 1
      }
    },

    async withIssuanceScope(bindings, callback) {
      const capturedBindings = immutableBindings(bindings)
      assertBindings(capturedBindings)
      const scope = new PlatformContentLockIssuanceScope(
        contentConstructionToken,
        capturedBindings,
      )
      const scopeState = issuanceScopeState(scope)
      let sealed = false
      try {
        const result = await callback({
          scope,
          seal(fragments) {
            if (!scopeState.active || sealed) {
              throw new CoordinationError('uow.scope-revoked')
            }
            sealed = true
            const slots = projectionsToSlots(fragments, 'issuance', scopeState)
            const payload = payloadFor(key, capturedBindings, slots)
            const canonicalPayload = canonicalStringify(
              payload as unknown as CanonicalValue,
            )
            const envelope = `${Buffer.from(canonicalPayload, 'utf8').toString('base64url')}.${signature(key, canonicalPayload).toString('base64url')}`
            if (Buffer.byteLength(envelope, 'utf8') > maximumEnvelopeBytes) {
              throw new CoordinationError('content-lock-plan.too-large')
            }
            return envelope as ContentLockPlanEnvelope
          },
        })
        if (!sealed) throw invalidPlan()
        return result
      } finally {
        scopeState.active = false
      }
    },

    activeVerifiedScopeCount() {
      return activeVerifiedScopes
    },
  }
}

export function consumeVerifiedContentLockPlan(
  plan: VerifiedContentLockPlan,
  request: UnitOfWorkRequest,
): ConsumedContentLockPlan {
  const { payload, bindings } = consumeVerifiedPlan(plan)
  assertPlanMatchesRequest(plan, bindings, request)
  const transactionScope = new PlatformContentLockTransactionScope(
    contentConstructionToken,
    bindings,
  )
  const transactionState = transactionScopeState(transactionScope)
  const attestor = new PlatformLockedContentPlanAttestor(
    contentConstructionToken,
    transactionState,
    payload.slots,
  )
  const consumed = new PlatformConsumedContentLockPlan({
    token: contentConstructionToken,
    abortController: verifiedPlanState(plan).child.abortController,
    attestor,
    lockKeys: payload.keys,
    transactionScope,
  })
  registerConsumedPlan(plan, consumed)
  return consumed
}

export function bindContentLockedUnitOfWorkExecution<Result>(
  plan: VerifiedContentLockPlan,
  execution: Promise<Result>,
): ContentLockedUnitOfWorkExecution<Result> {
  if (!verifiedPlanStates.has(plan)) {
    void execution.catch(() => undefined)
    throw new CoordinationError('uow.scope-revoked')
  }
  const wrapped = new PlatformContentLockedUnitOfWorkExecution(
    contentConstructionToken,
    plan,
    execution,
  )
  try {
    registerPlanExecution(plan, wrapped)
  } catch (error) {
    void execution.catch(() => undefined)
    throw error
  }
  return wrapped
}
