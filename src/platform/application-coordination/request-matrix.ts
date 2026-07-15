import type {
  ContentLockedUnitOfWorkRequest,
  ContentLockPlanBindings,
  ContentLockPlanShape,
  CredentialLifecycleMutationKind,
  DestructivePurpose,
  HostBootstrapMutationKind,
  IdentityRole,
  InstallationMutationEpoch,
  PrelockedSessionOperation,
  SubjectDataGeneration,
  UnitOfWorkRequest,
} from '@/application/coordination'
import { maximumContentLockPlanEnvelopeBytes } from './content-lock-plan'
import {
  installationMutationEpochWireValue,
  subjectDataGenerationWireValue,
} from './lifecycle-values'
import { prepareMutationAuthorityClaim } from './mutation-authority'

type AuthorityProfile =
  | { readonly kind: 'authenticated-session'; readonly role: 'any' | 'owner' }
  | {
      readonly kind: 'destructive-reauthentication-attempt'
      readonly purpose: DestructivePurpose
    }
  | {
      readonly kind: 'authenticated-destructive'
      readonly purpose: DestructivePurpose
    }
  | {
      readonly kind: 'credential-lifecycle'
      readonly mutation: CredentialLifecycleMutationKind
    }
  | {
      readonly kind: 'host-bootstrap'
      readonly mutation: HostBootstrapMutationKind
    }
  | { readonly kind: 'owner-recovery-issue' }
  | { readonly kind: 'expired-session-maintenance' }

type RequestProfile = {
  readonly operation: UnitOfWorkRequest['operation']
  readonly authority: AuthorityProfile
  readonly session: 'ordinary' | PrelockedSessionOperation
  readonly productFence: 'exclusive' | 'shared'
  readonly subjectLock: 'exclusive' | 'none' | 'shared'
  readonly content: 'unlocked' | ContentLockPlanShape
  readonly isolation: 'read-committed' | 'repeatable-read' | 'serializable'
  readonly access: 'read-only' | 'read-write'
}

type ContentVariantTag = ContentLockedUnitOfWorkRequest['operation']
type ReauthenticationVariantTag =
  `destructive-reauthentication-attempt:${DestructivePurpose}`
type DestructiveIdentityVariantTag =
  `destructive-identity-mutation:${Extract<DestructivePurpose, 'local-user-create' | 'member-reset-issue'>}`
type CredentialVariantTag =
  `credential-lifecycle-mutation:${CredentialLifecycleMutationKind}`
type BootstrapVariantTag = `host-bootstrap-mutation:${HostBootstrapMutationKind}`
type HostMaintenanceVariantTag =
  | 'host-maintenance:expired-session-maintenance'
  | 'host-maintenance:owner-recovery-issue'
type RequestVariantTag =
  | ContentVariantTag
  | ReauthenticationVariantTag
  | DestructiveIdentityVariantTag
  | CredentialVariantTag
  | BootstrapVariantTag
  | HostMaintenanceVariantTag
  | 'instance-reset'
  | 'subject-deletion'
  | 'subject-export'

/**
 * The complete runtime counterpart of the neutral request union. Adding a new typed variant must
 * add a row here before it can cross Platform admission.
 */
const requestProfiles = {
  'global-product-mutation': {
    operation: 'global-product-mutation',
    authority: { kind: 'authenticated-session', role: 'owner' },
    session: 'ordinary',
    productFence: 'shared',
    subjectLock: 'none',
    content: 'none',
    isolation: 'read-committed',
    access: 'read-write',
  },
  'content-release-revocation': {
    operation: 'content-release-revocation',
    authority: { kind: 'authenticated-session', role: 'owner' },
    session: 'ordinary',
    productFence: 'shared',
    subjectLock: 'none',
    content: 'release-revocation',
    isolation: 'read-committed',
    access: 'read-write',
  },
  'subject-product-mutation': {
    operation: 'subject-product-mutation',
    authority: { kind: 'authenticated-session', role: 'any' },
    session: 'ordinary',
    productFence: 'shared',
    subjectLock: 'exclusive',
    content: 'none',
    isolation: 'read-committed',
    access: 'read-write',
  },
  'current-publication.initial': {
    operation: 'current-publication.initial',
    authority: { kind: 'authenticated-session', role: 'any' },
    session: 'ordinary',
    productFence: 'shared',
    subjectLock: 'exclusive',
    content: 'current-publication.initial',
    isolation: 'read-committed',
    access: 'read-write',
  },
  'current-publication.existing': {
    operation: 'current-publication.existing',
    authority: { kind: 'authenticated-session', role: 'any' },
    session: 'ordinary',
    productFence: 'shared',
    subjectLock: 'exclusive',
    content: 'current-publication.existing',
    isolation: 'read-committed',
    access: 'read-write',
  },
  'stale-regeneration': {
    operation: 'stale-regeneration',
    authority: { kind: 'authenticated-session', role: 'any' },
    session: 'ordinary',
    productFence: 'shared',
    subjectLock: 'exclusive',
    content: 'stale-regeneration',
    isolation: 'read-committed',
    access: 'read-write',
  },
  'correction-closure': {
    operation: 'correction-closure',
    authority: { kind: 'authenticated-session', role: 'any' },
    session: 'ordinary',
    productFence: 'shared',
    subjectLock: 'exclusive',
    content: 'correction-closure',
    isolation: 'read-committed',
    access: 'read-write',
  },
  'subject-export': {
    operation: 'subject-export',
    authority: { kind: 'authenticated-session', role: 'any' },
    session: 'ordinary',
    productFence: 'shared',
    subjectLock: 'shared',
    content: 'unlocked',
    isolation: 'repeatable-read',
    access: 'read-only',
  },
  'subject-deletion': {
    operation: 'subject-deletion',
    authority: {
      kind: 'authenticated-destructive',
      purpose: 'trainee-data-deletion',
    },
    session: 'subject-deletion',
    productFence: 'shared',
    subjectLock: 'exclusive',
    content: 'unlocked',
    isolation: 'serializable',
    access: 'read-write',
  },
  'instance-reset': {
    operation: 'instance-reset',
    authority: { kind: 'authenticated-destructive', purpose: 'instance-reset' },
    session: 'instance-reset',
    productFence: 'exclusive',
    subjectLock: 'none',
    content: 'unlocked',
    isolation: 'serializable',
    access: 'read-write',
  },
  'destructive-reauthentication-attempt:trainee-data-deletion': {
    operation: 'destructive-reauthentication-attempt',
    authority: {
      kind: 'destructive-reauthentication-attempt',
      purpose: 'trainee-data-deletion',
    },
    session: 'subject-deletion',
    productFence: 'shared',
    subjectLock: 'none',
    content: 'unlocked',
    isolation: 'read-committed',
    access: 'read-write',
  },
  'destructive-reauthentication-attempt:instance-reset': {
    operation: 'destructive-reauthentication-attempt',
    authority: {
      kind: 'destructive-reauthentication-attempt',
      purpose: 'instance-reset',
    },
    session: 'instance-reset',
    productFence: 'shared',
    subjectLock: 'none',
    content: 'unlocked',
    isolation: 'read-committed',
    access: 'read-write',
  },
  'destructive-reauthentication-attempt:member-reset-issue': {
    operation: 'destructive-reauthentication-attempt',
    authority: {
      kind: 'destructive-reauthentication-attempt',
      purpose: 'member-reset-issue',
    },
    session: 'member-reset-issue',
    productFence: 'shared',
    subjectLock: 'none',
    content: 'unlocked',
    isolation: 'read-committed',
    access: 'read-write',
  },
  'destructive-reauthentication-attempt:local-user-create': {
    operation: 'destructive-reauthentication-attempt',
    authority: {
      kind: 'destructive-reauthentication-attempt',
      purpose: 'local-user-create',
    },
    session: 'local-user-create',
    productFence: 'shared',
    subjectLock: 'none',
    content: 'unlocked',
    isolation: 'read-committed',
    access: 'read-write',
  },
  'destructive-identity-mutation:member-reset-issue': {
    operation: 'destructive-identity-mutation',
    authority: {
      kind: 'authenticated-destructive',
      purpose: 'member-reset-issue',
    },
    session: 'member-reset-issue',
    productFence: 'shared',
    subjectLock: 'none',
    content: 'unlocked',
    isolation: 'serializable',
    access: 'read-write',
  },
  'destructive-identity-mutation:local-user-create': {
    operation: 'destructive-identity-mutation',
    authority: {
      kind: 'authenticated-destructive',
      purpose: 'local-user-create',
    },
    session: 'local-user-create',
    productFence: 'shared',
    subjectLock: 'none',
    content: 'unlocked',
    isolation: 'read-committed',
    access: 'read-write',
  },
  'credential-lifecycle-mutation:email-sign-in': {
    operation: 'credential-lifecycle-mutation',
    authority: { kind: 'credential-lifecycle', mutation: 'email-sign-in' },
    session: 'email-sign-in',
    productFence: 'shared',
    subjectLock: 'none',
    content: 'unlocked',
    isolation: 'read-committed',
    access: 'read-write',
  },
  'credential-lifecycle-mutation:checked-sign-out': {
    operation: 'credential-lifecycle-mutation',
    authority: { kind: 'credential-lifecycle', mutation: 'checked-sign-out' },
    session: 'checked-sign-out',
    productFence: 'shared',
    subjectLock: 'none',
    content: 'unlocked',
    isolation: 'read-committed',
    access: 'read-write',
  },
  'credential-lifecycle-mutation:member-reset-redemption': {
    operation: 'credential-lifecycle-mutation',
    authority: {
      kind: 'credential-lifecycle',
      mutation: 'member-reset-redemption',
    },
    session: 'member-reset-redemption',
    productFence: 'shared',
    subjectLock: 'none',
    content: 'unlocked',
    isolation: 'serializable',
    access: 'read-write',
  },
  'credential-lifecycle-mutation:owner-recovery-web-redemption': {
    operation: 'credential-lifecycle-mutation',
    authority: {
      kind: 'credential-lifecycle',
      mutation: 'owner-recovery-web-redemption',
    },
    session: 'owner-recovery-web-redemption',
    productFence: 'shared',
    subjectLock: 'none',
    content: 'unlocked',
    isolation: 'serializable',
    access: 'read-write',
  },
  'credential-lifecycle-mutation:owner-recovery-cli-redemption': {
    operation: 'credential-lifecycle-mutation',
    authority: {
      kind: 'credential-lifecycle',
      mutation: 'owner-recovery-cli-redemption',
    },
    session: 'owner-recovery-cli-redemption',
    productFence: 'shared',
    subjectLock: 'none',
    content: 'unlocked',
    isolation: 'serializable',
    access: 'read-write',
  },
  'host-bootstrap-mutation:issuance': {
    operation: 'host-bootstrap-mutation',
    authority: { kind: 'host-bootstrap', mutation: 'issuance' },
    session: 'bootstrap-issuance',
    productFence: 'shared',
    subjectLock: 'none',
    content: 'unlocked',
    isolation: 'serializable',
    access: 'read-write',
  },
  'host-bootstrap-mutation:redemption': {
    operation: 'host-bootstrap-mutation',
    authority: { kind: 'host-bootstrap', mutation: 'redemption' },
    session: 'bootstrap-redemption',
    productFence: 'shared',
    subjectLock: 'none',
    content: 'unlocked',
    isolation: 'serializable',
    access: 'read-write',
  },
  'host-maintenance:owner-recovery-issue': {
    operation: 'host-maintenance',
    authority: { kind: 'owner-recovery-issue' },
    session: 'owner-recovery-issue',
    productFence: 'shared',
    subjectLock: 'none',
    content: 'unlocked',
    isolation: 'serializable',
    access: 'read-write',
  },
  'host-maintenance:expired-session-maintenance': {
    operation: 'host-maintenance',
    authority: { kind: 'expired-session-maintenance' },
    session: 'expired-session-maintenance',
    productFence: 'shared',
    subjectLock: 'none',
    content: 'unlocked',
    isolation: 'read-committed',
    access: 'read-write',
  },
} as const satisfies Record<RequestVariantTag, RequestProfile>

function invalidRequest(): TypeError {
  return new TypeError('UnitOfWork request does not match the closed runtime matrix.')
}

function stableRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRequest()
  }
  let descriptors: { [key: string]: PropertyDescriptor }
  try {
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    throw invalidRequest()
  }
  const captured = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw invalidRequest()
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor)) throw invalidRequest()
    captured[key] = descriptor.value
  }
  return Object.freeze(captured)
}

function assertAllowedKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed)
  if (Object.keys(record).some((key) => !allowedSet.has(key))) throw invalidRequest()
}

function boundedString(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 300 ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 31 || code === 127
    })
  ) {
    throw invalidRequest()
  }
  return value
}

function opaqueCapability(value: unknown): object {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw invalidRequest()
  }
  return value
}

function installationEpoch(value: unknown): InstallationMutationEpoch {
  try {
    installationMutationEpochWireValue(value as InstallationMutationEpoch)
  } catch {
    throw invalidRequest()
  }
  return value as InstallationMutationEpoch
}

function subjectGeneration(value: unknown): SubjectDataGeneration {
  try {
    subjectDataGenerationWireValue(value as SubjectDataGeneration)
  } catch {
    throw invalidRequest()
  }
  return value as SubjectDataGeneration
}

function identityRole(value: unknown, required: 'any' | 'owner'): IdentityRole {
  if (value !== 'owner' && value !== 'member') throw invalidRequest()
  if (required === 'owner' && value !== 'owner') throw invalidRequest()
  return value
}

function targetForPurpose(
  purpose: DestructivePurpose,
  role: IdentityRole,
  target: unknown,
): string | null {
  if (purpose === 'trainee-data-deletion') {
    if (target !== null) throw invalidRequest()
    return null
  }
  if (role !== 'owner') throw invalidRequest()
  if (purpose === 'instance-reset') {
    if (target !== null) throw invalidRequest()
    return null
  }
  return boundedString(target)
}

function captureAuthority(
  raw: Readonly<Record<string, unknown>>,
  profile: AuthorityProfile,
): object {
  if (raw.kind !== profile.kind) throw invalidRequest()
  switch (profile.kind) {
    case 'authenticated-session': {
      assertAllowedKeys(raw, ['actorUserId', 'expectedRole', 'kind', 'session'])
      return Object.freeze({
        kind: profile.kind,
        actorUserId: boundedString(raw.actorUserId),
        expectedRole: identityRole(raw.expectedRole, profile.role),
        session: opaqueCapability(raw.session),
      })
    }
    case 'destructive-reauthentication-attempt':
    case 'authenticated-destructive': {
      const proofKey =
        profile.kind === 'destructive-reauthentication-attempt'
          ? 'attempt'
          : 'reauthenticationLease'
      assertAllowedKeys(raw, [
        'actorUserId',
        'expectedRole',
        'kind',
        'purpose',
        proofKey,
        'session',
        'targetUserId',
      ])
      if (raw.purpose !== profile.purpose) throw invalidRequest()
      const role = identityRole(raw.expectedRole, 'any')
      const base = {
        kind: profile.kind,
        actorUserId: boundedString(raw.actorUserId),
        expectedRole: role,
        session: opaqueCapability(raw.session),
        purpose: profile.purpose,
        targetUserId: targetForPurpose(profile.purpose, role, raw.targetUserId),
      }
      return Object.freeze({
        ...base,
        [proofKey]: opaqueCapability(raw[proofKey]),
      })
    }
    case 'credential-lifecycle':
      assertAllowedKeys(raw, ['authority', 'kind', 'mutation'])
      if (raw.mutation !== profile.mutation) throw invalidRequest()
      return Object.freeze({
        kind: profile.kind,
        mutation: profile.mutation,
        authority: opaqueCapability(raw.authority),
      })
    case 'host-bootstrap':
      assertAllowedKeys(raw, ['authority', 'kind', 'mutation'])
      if (raw.mutation !== profile.mutation) throw invalidRequest()
      return Object.freeze({
        kind: profile.kind,
        mutation: profile.mutation,
        authority: opaqueCapability(raw.authority),
      })
    case 'owner-recovery-issue':
      assertAllowedKeys(raw, ['expectedOwnerUserId', 'invocation', 'kind'])
      return Object.freeze({
        kind: profile.kind,
        expectedOwnerUserId: boundedString(raw.expectedOwnerUserId),
        invocation: opaqueCapability(raw.invocation),
      })
    case 'expired-session-maintenance': {
      assertAllowedKeys(raw, ['batchSize', 'cursor', 'invocation', 'kind'])
      if (
        !Number.isSafeInteger(raw.batchSize) ||
        (raw.batchSize as number) < 1 ||
        (raw.batchSize as number) > 1_000
      ) {
        throw invalidRequest()
      }
      const cursor = raw.cursor === null ? null : boundedString(raw.cursor)
      return Object.freeze({
        kind: profile.kind,
        cursor,
        batchSize: raw.batchSize,
        invocation: opaqueCapability(raw.invocation),
      })
    }
  }
}

function captureSession(
  raw: Readonly<Record<string, unknown>>,
  expected: RequestProfile['session'],
): object {
  if (expected === 'ordinary') {
    assertAllowedKeys(raw, ['kind'])
    if (raw.kind !== 'ordinary') throw invalidRequest()
    return Object.freeze({ kind: 'ordinary' })
  }
  assertAllowedKeys(raw, ['kind', 'lease'])
  if (raw.kind !== 'prelocked') throw invalidRequest()
  return Object.freeze({
    kind: 'prelocked',
    lease: opaqueCapability(raw.lease),
  })
}

function captureSubjectLock(
  raw: unknown,
  expected: RequestProfile['subjectLock'],
): object | null {
  if (expected === 'none') {
    if (raw !== null) throw invalidRequest()
    return null
  }
  const lock = stableRecord(raw)
  assertAllowedKeys(lock, ['mode', 'subjectUserId'])
  if (lock.mode !== expected) throw invalidRequest()
  return Object.freeze({
    subjectUserId: boundedString(lock.subjectUserId),
    mode: expected,
  })
}

function captureStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw invalidRequest()
  let descriptors: { [key: string]: PropertyDescriptor }
  try {
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    throw invalidRequest()
  }
  const lengthDescriptor = descriptors.length
  if (
    !lengthDescriptor ||
    !('value' in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    // Every canonical nonempty string consumes at least one envelope byte, so a larger array
    // cannot correspond to a valid 16 KiB plan. The actual envelope remains the tighter bound.
    lengthDescriptor.value > maximumContentLockPlanEnvelopeBytes
  ) {
    throw invalidRequest()
  }
  const captured = new Array<string>(lengthDescriptor.value)
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key)) {
      throw invalidRequest()
    }
    const index = Number(key)
    const descriptor = descriptors[key]
    if (index >= captured.length || !descriptor || !('value' in descriptor)) {
      throw invalidRequest()
    }
    captured[index] = boundedString(descriptor.value)
  }
  for (let index = 0; index < captured.length; index += 1) {
    if (!Object.hasOwn(descriptors, String(index))) throw invalidRequest()
  }
  return Object.freeze(captured)
}

function captureBindings(
  value: unknown,
  shape: ContentLockPlanShape,
): ContentLockPlanBindings {
  const raw = stableRecord(value)
  assertAllowedKeys(raw, [
    'actorAccountId',
    'expectedEpoch',
    'expectedGeneration',
    'formOrCommandId',
    'purpose',
    'shape',
    'sourceEntityIds',
    'subjectId',
  ])
  if (raw.shape !== shape) throw invalidRequest()
  const expectedEpoch = installationEpoch(raw.expectedEpoch)
  const expectedGeneration =
    raw.expectedGeneration === null ? null : subjectGeneration(raw.expectedGeneration)
  return Object.freeze({
    shape,
    purpose: boundedString(raw.purpose),
    actorAccountId: boundedString(raw.actorAccountId),
    subjectId: raw.subjectId === null ? null : boundedString(raw.subjectId),
    formOrCommandId: boundedString(raw.formOrCommandId),
    sourceEntityIds: captureStringArray(raw.sourceEntityIds),
    expectedEpoch,
    expectedGeneration,
  })
}

function captureContent(value: unknown, expected: RequestProfile['content']): object {
  const raw = stableRecord(value)
  if (expected === 'unlocked' && raw.kind === 'none') {
    assertAllowedKeys(raw, ['kind'])
    return Object.freeze({ kind: 'none' })
  }
  if (expected === 'unlocked' || raw.kind !== 'verified') throw invalidRequest()
  assertAllowedKeys(raw, ['bindings', 'kind', 'plan'])
  return Object.freeze({
    kind: 'verified',
    plan: opaqueCapability(raw.plan),
    bindings: captureBindings(raw.bindings, expected),
  })
}

function variantTag(
  operation: unknown,
  authority: Readonly<Record<string, unknown>>,
): string {
  if (typeof operation !== 'string') throw invalidRequest()
  const qualifier = (value: unknown): string => {
    if (typeof value !== 'string') throw invalidRequest()
    return value
  }
  switch (operation) {
    case 'destructive-reauthentication-attempt':
    case 'destructive-identity-mutation':
      return `${operation}:${qualifier(authority.purpose)}`
    case 'credential-lifecycle-mutation':
    case 'host-bootstrap-mutation':
      return `${operation}:${qualifier(authority.mutation)}`
    case 'host-maintenance':
      return `${operation}:${qualifier(authority.kind)}`
    default:
      return operation
  }
}

/**
 * Captures every caller-controlled structural field exactly once, rejects accessors and invalid
 * cross-products, and returns a frozen canonical request whose lock/access choices are profile-
 * derived rather than caller-selected.
 */
export function captureUnitOfWorkRequest(value: unknown): UnitOfWorkRequest {
  const raw = stableRecord(value)
  assertAllowedKeys(raw, [
    'authority',
    'content',
    'expectedEpoch',
    'mode',
    'operation',
    'productFence',
    'session',
    'signal',
    'subjectLock',
    'workflowPurpose',
  ])
  const rawAuthority = stableRecord(raw.authority)
  const tag = variantTag(raw.operation, rawAuthority)
  if (!Object.hasOwn(requestProfiles, tag)) throw invalidRequest()
  const profile = requestProfiles[tag as RequestVariantTag]
  if (profile.operation !== raw.operation) throw invalidRequest()
  if (raw.productFence !== profile.productFence) throw invalidRequest()
  const rawMode = stableRecord(raw.mode)
  assertAllowedKeys(rawMode, ['access', 'isolation'])
  if (rawMode.access !== profile.access || rawMode.isolation !== profile.isolation) {
    throw invalidRequest()
  }
  const expectedEpoch = installationEpoch(raw.expectedEpoch)
  if (raw.signal !== undefined && !(raw.signal instanceof AbortSignal)) {
    throw invalidRequest()
  }

  const captured: Record<string, unknown> = {
    operation: profile.operation,
    authority: captureAuthority(rawAuthority, profile.authority),
    session: captureSession(stableRecord(raw.session), profile.session),
    expectedEpoch,
    productFence: profile.productFence,
    subjectLock: captureSubjectLock(raw.subjectLock, profile.subjectLock),
    content: captureContent(raw.content, profile.content),
    mode: Object.freeze({
      isolation: profile.isolation,
      access: profile.access,
    }),
  }
  if (profile.content !== 'unlocked') {
    captured.workflowPurpose = boundedString(raw.workflowPurpose)
  } else if (raw.workflowPurpose !== undefined) {
    throw invalidRequest()
  }
  if (raw.signal !== undefined) captured.signal = raw.signal
  const request = Object.freeze(captured) as UnitOfWorkRequest
  prepareMutationAuthorityClaim(
    request,
    profile.session === 'ordinary' ? null : profile.session,
  )
  return request
}
