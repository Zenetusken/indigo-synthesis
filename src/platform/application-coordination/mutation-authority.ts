import {
  type AuthenticatedDestructiveAuthority,
  type AuthenticatedSessionAuthority,
  AuthenticatedSessionReference,
  CoordinationError,
  CredentialLifecycleAuthority,
  type CredentialLifecycleMutationAuthority,
  type CredentialLifecycleMutationKind,
  type DestructivePurpose,
  DestructiveReauthenticationAttempt,
  type DestructiveReauthenticationAttemptAuthority,
  DestructiveReauthenticationLease,
  type ExpiredSessionMaintenanceAuthority,
  HostBootstrapAuthority,
  type HostBootstrapMutationAuthority,
  HostInvocationAuthority,
  type IdentityRole,
  type InstallationMutationEpoch,
  type MutationAuthority,
  type OwnerRecoveryIssueAuthority,
  type PrelockedSessionOperation,
  type UnitOfWorkRequest,
} from '@/application/coordination'
import { installationMutationEpochWireValue } from './lifecycle-values'

type Issued<Authority extends MutationAuthority> = Readonly<{
  readonly authority: Authority
  readonly expectedEpoch: InstallationMutationEpoch
}>

export type IssuedMutationAuthority<Authority extends MutationAuthority> =
  Issued<Authority>

export type IssuedAuthenticatedSession<Role extends IdentityRole = IdentityRole> = Issued<
  AuthenticatedSessionAuthority & { readonly expectedRole: Role }
>

type AttemptAuthority<Purpose extends DestructivePurpose> = Extract<
  DestructiveReauthenticationAttemptAuthority,
  { readonly purpose: Purpose }
>

type ProtectedAuthority<Purpose extends DestructivePurpose> = Extract<
  AuthenticatedDestructiveAuthority,
  { readonly purpose: Purpose }
>

type CredentialAuthority<Mutation extends CredentialLifecycleMutationKind> = Extract<
  CredentialLifecycleMutationAuthority,
  { readonly mutation: Mutation }
>

type BootstrapAuthority<Mutation extends 'issuance' | 'redemption'> = Extract<
  HostBootstrapMutationAuthority,
  { readonly mutation: Mutation }
>

export type IssuedDestructiveAttempt<Purpose extends DestructivePurpose> = Issued<
  AttemptAuthority<Purpose>
>

export type IssuedProtectedDestructive<Purpose extends DestructivePurpose> = Issued<
  ProtectedAuthority<Purpose>
>

export type IssuedCredentialLifecycle<Mutation extends CredentialLifecycleMutationKind> =
  Issued<CredentialAuthority<Mutation>>

export type IssuedHostBootstrap<Mutation extends 'issuance' | 'redemption'> = Issued<
  BootstrapAuthority<Mutation>
>

export type IssuedOwnerRecovery = Issued<OwnerRecoveryIssueAuthority>
export type IssuedExpiredSessionMaintenance = Issued<ExpiredSessionMaintenanceAuthority>

type ScopePhase =
  | 'issued'
  | 'ready'
  | 'direct-in-flight'
  | 'attempt-in-flight'
  | 'protected-ready'
  | 'protected-in-flight'
  | 'terminal'

type OneUseStatus = 'fresh' | 'in-flight' | 'pending' | 'spent'

type ScopeState = {
  readonly expectedEpoch: InstallationMutationEpoch
  readonly operation: PrelockedSessionOperation
  phase: ScopePhase
  active: boolean
  prelockConsumed: boolean
  readonly initialCapability: OneUseCapabilityState
  pendingProtected: ProtectedCapabilityState | null
}

/** Platform-private scope identity copied into an intent and its eventual lease. */
export abstract class PlatformMutationAuthorityScope {
  protected declare readonly platformMutationAuthorityScopeNominal: never

  protected constructor() {}
}

const authorityConstructionToken = Object.freeze({})
const scopeStates = new WeakMap<object, ScopeState>()

class ConcreteMutationAuthorityScope extends PlatformMutationAuthorityScope {
  constructor(token: typeof authorityConstructionToken) {
    super()
    if (token !== authorityConstructionToken) throw staleAuthority()
  }
}

type SessionReferenceState = {
  readonly kind: 'authenticated-session'
  readonly expectedEpoch: InstallationMutationEpoch
  readonly actorUserId: string
  readonly sessionId: string
  readonly expectedRole: IdentityRole
}

type DestructiveBinding = {
  readonly expectedEpoch: InstallationMutationEpoch
  readonly actorUserId: string
  readonly sessionId: string
  readonly session: AuthenticatedSessionReference
  readonly expectedRole: IdentityRole
  readonly purpose: DestructivePurpose
  readonly targetUserId: string | null
}

type AttemptCapabilityState = DestructiveBinding & {
  readonly kind: 'destructive-reauthentication-attempt'
  readonly emailDigest: string | null
  readonly capability: DestructiveReauthenticationAttempt<DestructivePurpose>
  readonly scope: PlatformMutationAuthorityScope
  status: OneUseStatus
}

type ProtectedCapabilityState = DestructiveBinding & {
  readonly kind: 'authenticated-destructive'
  readonly emailDigest: string | null
  readonly capability: DestructiveReauthenticationLease<DestructivePurpose>
  readonly scope: PlatformMutationAuthorityScope
  status: OneUseStatus
}

type EmailSignInCapabilityState = {
  readonly kind: 'credential-lifecycle'
  readonly mutation: 'email-sign-in'
  readonly expectedEpoch: InstallationMutationEpoch
  readonly emailDigest: string
  readonly resolvedAccountUserIds: readonly string[]
  readonly capability: CredentialLifecycleAuthority<'email-sign-in'>
  readonly scope: PlatformMutationAuthorityScope
  status: OneUseStatus
}

type CheckedSignOutCapabilityState = {
  readonly kind: 'credential-lifecycle'
  readonly mutation: 'checked-sign-out'
  readonly expectedEpoch: InstallationMutationEpoch
  readonly signedTokenDigest: string
  readonly resolvedAccountUserId: string
  readonly capability: CredentialLifecycleAuthority<'checked-sign-out'>
  readonly scope: PlatformMutationAuthorityScope
  status: OneUseStatus
}

type ResetRedemptionMutation =
  | 'member-reset-redemption'
  | 'owner-recovery-web-redemption'
  | 'owner-recovery-cli-redemption'

type ResetChannelByMutation = {
  readonly 'member-reset-redemption': 'member'
  readonly 'owner-recovery-web-redemption': 'owner-web'
  readonly 'owner-recovery-cli-redemption': 'owner-cli'
}

type ResetRedemptionCapabilityState = {
  [Mutation in ResetRedemptionMutation]: {
    readonly kind: 'credential-lifecycle'
    readonly mutation: Mutation
    readonly expectedEpoch: InstallationMutationEpoch
    readonly codeIdentity: string
    readonly emailDigest: string | null
    readonly hostInvocationId: string | null
    readonly targetUserId: string | null
    readonly channel: ResetChannelByMutation[Mutation]
    readonly capability: CredentialLifecycleAuthority<Mutation>
    readonly scope: PlatformMutationAuthorityScope
    status: OneUseStatus
  }
}[ResetRedemptionMutation]

type BootstrapIssuanceCapabilityState = {
  readonly kind: 'host-bootstrap'
  readonly mutation: 'issuance'
  readonly expectedEpoch: InstallationMutationEpoch
  readonly capabilityIdentity: string
  readonly hostInvocationId: string
  readonly capability: HostBootstrapAuthority<'issuance'>
  readonly scope: PlatformMutationAuthorityScope
  status: OneUseStatus
}

type BootstrapRedemptionCapabilityState = {
  readonly kind: 'host-bootstrap'
  readonly mutation: 'redemption'
  readonly expectedEpoch: InstallationMutationEpoch
  readonly capabilityIdentity: string
  readonly codeIdentity: string
  readonly preallocatedOwnerUserId: string
  readonly emailDigest: string
  readonly capability: HostBootstrapAuthority<'redemption'>
  readonly scope: PlatformMutationAuthorityScope
  status: OneUseStatus
}

type OwnerRecoveryIssueCapabilityState = {
  readonly kind: 'owner-recovery-issue'
  readonly expectedEpoch: InstallationMutationEpoch
  readonly expectedOwnerUserId: string
  readonly hostInvocationId: string
  readonly capability: HostInvocationAuthority<'owner-recovery-issue'>
  readonly scope: PlatformMutationAuthorityScope
  status: OneUseStatus
}

type ExpiredSessionMaintenanceCapabilityState = {
  readonly kind: 'expired-session-maintenance'
  readonly expectedEpoch: InstallationMutationEpoch
  readonly expectedOwnerUserId: string
  readonly hostInvocationId: string
  readonly cursor: string | null
  readonly batchSize: number
  readonly resolvedAccountUserIds: readonly string[]
  readonly capability: HostInvocationAuthority<'expired-session-maintenance'>
  readonly scope: PlatformMutationAuthorityScope
  status: OneUseStatus
}

type DirectCapabilityState =
  | EmailSignInCapabilityState
  | CheckedSignOutCapabilityState
  | ResetRedemptionCapabilityState
  | BootstrapIssuanceCapabilityState
  | BootstrapRedemptionCapabilityState
  | OwnerRecoveryIssueCapabilityState
  | ExpiredSessionMaintenanceCapabilityState

type OneUseCapabilityState =
  | AttemptCapabilityState
  | ProtectedCapabilityState
  | DirectCapabilityState

type CapabilityState = SessionReferenceState | OneUseCapabilityState

type WithoutScope<State> = State extends unknown ? Omit<State, 'scope'> : never

const capabilityStates = new WeakMap<object, CapabilityState>()

class PlatformAuthenticatedSessionReference extends AuthenticatedSessionReference {
  constructor(token: typeof authorityConstructionToken) {
    super()
    if (token !== authorityConstructionToken) throw staleAuthority()
  }
}

class PlatformDestructiveAttempt<
  Purpose extends DestructivePurpose,
> extends DestructiveReauthenticationAttempt<Purpose> {
  constructor(token: typeof authorityConstructionToken) {
    super()
    if (token !== authorityConstructionToken) throw staleAuthority()
  }
}

class PlatformDestructiveLease<
  Purpose extends DestructivePurpose,
> extends DestructiveReauthenticationLease<Purpose> {
  constructor(token: typeof authorityConstructionToken) {
    super()
    if (token !== authorityConstructionToken) throw staleAuthority()
  }
}

class PlatformCredentialLifecycleAuthority<
  Mutation extends CredentialLifecycleMutationKind,
> extends CredentialLifecycleAuthority<Mutation> {
  constructor(token: typeof authorityConstructionToken) {
    super()
    if (token !== authorityConstructionToken) throw staleAuthority()
  }
}

class PlatformHostBootstrapAuthority<
  Mutation extends 'issuance' | 'redemption',
> extends HostBootstrapAuthority<Mutation> {
  constructor(token: typeof authorityConstructionToken) {
    super()
    if (token !== authorityConstructionToken) throw staleAuthority()
  }
}

class PlatformHostInvocationAuthority<
  Kind extends 'owner-recovery-issue' | 'expired-session-maintenance',
> extends HostInvocationAuthority<Kind> {
  constructor(token: typeof authorityConstructionToken) {
    super()
    if (token !== authorityConstructionToken) throw staleAuthority()
  }
}

function staleAuthority(): CoordinationError {
  return new CoordinationError('identity.authority-stale')
}

function invalidInput(): TypeError {
  return new TypeError('Mutation authority input is invalid.')
}

function canonicalString(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 300 ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 31 || code === 127
    })
  ) {
    throw invalidInput()
  }
  return value
}

function expectedEpoch(value: InstallationMutationEpoch): InstallationMutationEpoch {
  try {
    installationMutationEpochWireValue(value)
  } catch {
    throw invalidInput()
  }
  return value
}

function canonicalAccountIds(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length > 1_000) throw invalidInput()
  const captured = value.map(canonicalString).sort()
  if (captured.some((item, index) => index > 0 && item === captured[index - 1])) {
    throw invalidInput()
  }
  return Object.freeze(captured)
}

function frozen<Shape extends object>(value: Shape): Readonly<Shape> {
  return Object.freeze(value)
}

function createScope(
  epoch: InstallationMutationEpoch,
  operation: PrelockedSessionOperation,
  initialCapability: OneUseCapabilityState,
): PlatformMutationAuthorityScope {
  const scope = new ConcreteMutationAuthorityScope(authorityConstructionToken)
  scopeStates.set(scope, {
    expectedEpoch: epoch,
    operation,
    phase: 'issued',
    active: true,
    prelockConsumed: false,
    initialCapability,
    pendingProtected: null,
  })
  return scope
}

function attachScope(
  state: WithoutScope<AttemptCapabilityState>,
  operation: PrelockedSessionOperation,
): AttemptCapabilityState
function attachScope(
  state: WithoutScope<DirectCapabilityState>,
  operation: PrelockedSessionOperation,
): DirectCapabilityState
function attachScope(
  state: WithoutScope<OneUseCapabilityState>,
  operation: PrelockedSessionOperation,
): OneUseCapabilityState {
  const placeholder = Object.create(null) as OneUseCapabilityState
  const scope = createScope(state.expectedEpoch, operation, placeholder)
  const complete = { ...state, scope } as OneUseCapabilityState
  const scopeState = scopeStates.get(scope)
  if (!scopeState) throw staleAuthority()
  ;(scopeState as { initialCapability: OneUseCapabilityState }).initialCapability =
    complete
  capabilityStates.set(complete.capability, complete)
  return complete
}

function sessionState(
  issued: IssuedAuthenticatedSession,
  requiredRole: 'any' | 'owner',
): SessionReferenceState {
  if (issued === null || typeof issued !== 'object') throw invalidInput()
  const authority = issued.authority
  const state = capabilityStates.get(authority?.session)
  if (
    state?.kind !== 'authenticated-session' ||
    issued.expectedEpoch !== state.expectedEpoch ||
    authority.kind !== 'authenticated-session' ||
    authority.actorUserId !== state.actorUserId ||
    authority.expectedRole !== state.expectedRole ||
    (requiredRole === 'owner' && state.expectedRole !== 'owner')
  ) {
    throw staleAuthority()
  }
  return state
}

function destructiveBinding(
  issued: IssuedAuthenticatedSession,
  purpose: DestructivePurpose,
  targetUserId: string | null,
  requiredRole: 'any' | 'owner',
): DestructiveBinding {
  const state = sessionState(issued, requiredRole)
  return {
    expectedEpoch: state.expectedEpoch,
    actorUserId: state.actorUserId,
    sessionId: state.sessionId,
    session: issued.authority.session,
    expectedRole: state.expectedRole,
    purpose,
    targetUserId,
  }
}

function issueAttempt<Purpose extends DestructivePurpose>(
  binding: DestructiveBinding & {
    readonly purpose: Purpose
    readonly emailDigest?: string | null
  },
  operation: PrelockedSessionOperation,
): IssuedDestructiveAttempt<Purpose> {
  const capability = new PlatformDestructiveAttempt<Purpose>(authorityConstructionToken)
  attachScope(
    {
      kind: 'destructive-reauthentication-attempt',
      ...binding,
      emailDigest:
        binding.emailDigest === undefined || binding.emailDigest === null
          ? null
          : canonicalString(binding.emailDigest),
      capability,
      status: 'fresh',
    },
    operation,
  )
  return frozen({
    expectedEpoch: binding.expectedEpoch,
    authority: frozen({
      kind: 'destructive-reauthentication-attempt',
      actorUserId: binding.actorUserId,
      expectedRole: binding.expectedRole,
      session: binding.session,
      purpose: binding.purpose,
      targetUserId: binding.targetUserId,
      attempt: capability,
    }) as unknown as AttemptAuthority<Purpose>,
  })
}

function issueCredential<Mutation extends CredentialLifecycleMutationKind>(
  state: WithoutScope<Extract<DirectCapabilityState, { readonly mutation: Mutation }>>,
  operation: PrelockedSessionOperation,
): IssuedCredentialLifecycle<Mutation> {
  const complete = attachScope(state as WithoutScope<DirectCapabilityState>, operation)
  return frozen({
    expectedEpoch: state.expectedEpoch,
    authority: frozen({
      kind: 'credential-lifecycle',
      mutation: state.mutation,
      authority: complete.capability,
    }) as unknown as CredentialAuthority<Mutation>,
  })
}

export type PlatformMutationAuthorityIssuer = {
  authenticatedSession<Role extends IdentityRole>(input: {
    readonly expectedEpoch: InstallationMutationEpoch
    readonly actorUserId: string
    readonly sessionId: string
    readonly expectedRole: Role
  }): IssuedAuthenticatedSession<Role>
  traineeDataDeletionAttempt(input: {
    readonly authenticated: IssuedAuthenticatedSession
  }): IssuedDestructiveAttempt<'trainee-data-deletion'>
  instanceResetAttempt(input: {
    readonly authenticated: IssuedAuthenticatedSession<'owner'>
  }): IssuedDestructiveAttempt<'instance-reset'>
  memberResetIssueAttempt(input: {
    readonly authenticated: IssuedAuthenticatedSession<'owner'>
    readonly targetUserId: string
  }): IssuedDestructiveAttempt<'member-reset-issue'>
  localUserCreateAttempt(input: {
    readonly authenticated: IssuedAuthenticatedSession<'owner'>
    readonly targetUserId: string
    readonly emailDigest: string
  }): IssuedDestructiveAttempt<'local-user-create'>
  emailSignIn(input: {
    readonly expectedEpoch: InstallationMutationEpoch
    readonly emailDigest: string
    readonly resolvedAccountUserIds: readonly string[]
  }): IssuedCredentialLifecycle<'email-sign-in'>
  checkedSignOut(input: {
    readonly expectedEpoch: InstallationMutationEpoch
    readonly signedTokenDigest: string
    readonly resolvedAccountUserId: string
  }): IssuedCredentialLifecycle<'checked-sign-out'>
  memberResetRedemption(input: {
    readonly expectedEpoch: InstallationMutationEpoch
    readonly codeIdentity: string
    readonly emailDigest: string
    readonly targetUserId: string | null
  }): IssuedCredentialLifecycle<'member-reset-redemption'>
  ownerRecoveryWebRedemption(input: {
    readonly expectedEpoch: InstallationMutationEpoch
    readonly codeIdentity: string
    readonly emailDigest: string
    readonly expectedOwnerUserId: string
  }): IssuedCredentialLifecycle<'owner-recovery-web-redemption'>
  ownerRecoveryCliRedemption(input: {
    readonly expectedEpoch: InstallationMutationEpoch
    readonly codeIdentity: string
    readonly expectedOwnerUserId: string
    readonly hostInvocationId: string
  }): IssuedCredentialLifecycle<'owner-recovery-cli-redemption'>
  bootstrapIssuance(input: {
    readonly expectedEpoch: InstallationMutationEpoch
    readonly capabilityIdentity: string
    readonly hostInvocationId: string
  }): IssuedHostBootstrap<'issuance'>
  bootstrapRedemption(input: {
    readonly expectedEpoch: InstallationMutationEpoch
    readonly capabilityIdentity: string
    readonly codeIdentity: string
    readonly preallocatedOwnerUserId: string
    readonly emailDigest: string
  }): IssuedHostBootstrap<'redemption'>
  ownerRecoveryIssue(input: {
    readonly expectedEpoch: InstallationMutationEpoch
    readonly expectedOwnerUserId: string
    readonly hostInvocationId: string
  }): IssuedOwnerRecovery
  expiredSessionMaintenance(input: {
    readonly expectedEpoch: InstallationMutationEpoch
    readonly expectedOwnerUserId: string
    readonly hostInvocationId: string
    readonly cursor: string | null
    readonly batchSize: number
    readonly resolvedAccountUserIds: readonly string[]
  }): IssuedExpiredSessionMaintenance
}

/** Exact named methods prevent a caller-controlled tag from being promoted into authority. */
export function createPlatformMutationAuthorityIssuer(): PlatformMutationAuthorityIssuer {
  return {
    authenticatedSession(input) {
      const epoch = expectedEpoch(input.expectedEpoch)
      const actorUserId = canonicalString(input.actorUserId)
      const sessionId = canonicalString(input.sessionId)
      if (input.expectedRole !== 'owner' && input.expectedRole !== 'member') {
        throw invalidInput()
      }
      const session = new PlatformAuthenticatedSessionReference(
        authorityConstructionToken,
      )
      capabilityStates.set(session, {
        kind: 'authenticated-session',
        expectedEpoch: epoch,
        actorUserId,
        sessionId,
        expectedRole: input.expectedRole,
      })
      return frozen({
        expectedEpoch: epoch,
        authority: frozen({
          kind: 'authenticated-session',
          actorUserId,
          expectedRole: input.expectedRole,
          session,
        }),
      })
    },
    traineeDataDeletionAttempt({ authenticated }) {
      const binding = destructiveBinding(
        authenticated,
        'trainee-data-deletion',
        null,
        'any',
      )
      return issueAttempt(
        { ...binding, purpose: 'trainee-data-deletion' },
        'subject-deletion',
      )
    },
    instanceResetAttempt({ authenticated }) {
      const binding = destructiveBinding(authenticated, 'instance-reset', null, 'owner')
      return issueAttempt({ ...binding, purpose: 'instance-reset' }, 'instance-reset')
    },
    memberResetIssueAttempt({ authenticated, targetUserId }) {
      const binding = destructiveBinding(
        authenticated,
        'member-reset-issue',
        canonicalString(targetUserId),
        'owner',
      )
      return issueAttempt(
        { ...binding, purpose: 'member-reset-issue' },
        'member-reset-issue',
      )
    },
    localUserCreateAttempt({ authenticated, targetUserId, emailDigest }) {
      const binding = destructiveBinding(
        authenticated,
        'local-user-create',
        canonicalString(targetUserId),
        'owner',
      )
      return issueAttempt(
        { ...binding, purpose: 'local-user-create', emailDigest },
        'local-user-create',
      )
    },
    emailSignIn(input) {
      const epoch = expectedEpoch(input.expectedEpoch)
      const capability = new PlatformCredentialLifecycleAuthority<'email-sign-in'>(
        authorityConstructionToken,
      )
      return issueCredential(
        {
          kind: 'credential-lifecycle',
          mutation: 'email-sign-in',
          expectedEpoch: epoch,
          emailDigest: canonicalString(input.emailDigest),
          resolvedAccountUserIds: canonicalAccountIds(input.resolvedAccountUserIds),
          capability,
          status: 'fresh',
        },
        'email-sign-in',
      )
    },
    checkedSignOut(input) {
      const epoch = expectedEpoch(input.expectedEpoch)
      const capability = new PlatformCredentialLifecycleAuthority<'checked-sign-out'>(
        authorityConstructionToken,
      )
      return issueCredential(
        {
          kind: 'credential-lifecycle',
          mutation: 'checked-sign-out',
          expectedEpoch: epoch,
          signedTokenDigest: canonicalString(input.signedTokenDigest),
          resolvedAccountUserId: canonicalString(input.resolvedAccountUserId),
          capability,
          status: 'fresh',
        },
        'checked-sign-out',
      )
    },
    memberResetRedemption(input) {
      const epoch = expectedEpoch(input.expectedEpoch)
      const capability =
        new PlatformCredentialLifecycleAuthority<'member-reset-redemption'>(
          authorityConstructionToken,
        )
      return issueCredential(
        {
          kind: 'credential-lifecycle',
          mutation: 'member-reset-redemption',
          expectedEpoch: epoch,
          codeIdentity: canonicalString(input.codeIdentity),
          emailDigest: canonicalString(input.emailDigest),
          hostInvocationId: null,
          targetUserId:
            input.targetUserId === null ? null : canonicalString(input.targetUserId),
          channel: 'member',
          capability,
          status: 'fresh',
        },
        'member-reset-redemption',
      )
    },
    ownerRecoveryWebRedemption(input) {
      const epoch = expectedEpoch(input.expectedEpoch)
      const capability =
        new PlatformCredentialLifecycleAuthority<'owner-recovery-web-redemption'>(
          authorityConstructionToken,
        )
      return issueCredential(
        {
          kind: 'credential-lifecycle',
          mutation: 'owner-recovery-web-redemption',
          expectedEpoch: epoch,
          codeIdentity: canonicalString(input.codeIdentity),
          emailDigest: canonicalString(input.emailDigest),
          hostInvocationId: null,
          targetUserId: canonicalString(input.expectedOwnerUserId),
          channel: 'owner-web',
          capability,
          status: 'fresh',
        },
        'owner-recovery-web-redemption',
      )
    },
    ownerRecoveryCliRedemption(input) {
      const epoch = expectedEpoch(input.expectedEpoch)
      const capability =
        new PlatformCredentialLifecycleAuthority<'owner-recovery-cli-redemption'>(
          authorityConstructionToken,
        )
      return issueCredential(
        {
          kind: 'credential-lifecycle',
          mutation: 'owner-recovery-cli-redemption',
          expectedEpoch: epoch,
          codeIdentity: canonicalString(input.codeIdentity),
          emailDigest: null,
          hostInvocationId: canonicalString(input.hostInvocationId),
          targetUserId: canonicalString(input.expectedOwnerUserId),
          channel: 'owner-cli',
          capability,
          status: 'fresh',
        },
        'owner-recovery-cli-redemption',
      )
    },
    bootstrapIssuance(input) {
      const epoch = expectedEpoch(input.expectedEpoch)
      const capability = new PlatformHostBootstrapAuthority<'issuance'>(
        authorityConstructionToken,
      )
      const complete = attachScope(
        {
          kind: 'host-bootstrap',
          mutation: 'issuance',
          expectedEpoch: epoch,
          capabilityIdentity: canonicalString(input.capabilityIdentity),
          hostInvocationId: canonicalString(input.hostInvocationId),
          capability,
          status: 'fresh',
        },
        'bootstrap-issuance',
      ) as BootstrapIssuanceCapabilityState
      return frozen({
        expectedEpoch: epoch,
        authority: frozen({
          kind: 'host-bootstrap',
          mutation: 'issuance',
          authority: complete.capability,
        }),
      })
    },
    bootstrapRedemption(input) {
      const epoch = expectedEpoch(input.expectedEpoch)
      const capability = new PlatformHostBootstrapAuthority<'redemption'>(
        authorityConstructionToken,
      )
      const complete = attachScope(
        {
          kind: 'host-bootstrap',
          mutation: 'redemption',
          expectedEpoch: epoch,
          capabilityIdentity: canonicalString(input.capabilityIdentity),
          codeIdentity: canonicalString(input.codeIdentity),
          preallocatedOwnerUserId: canonicalString(input.preallocatedOwnerUserId),
          emailDigest: canonicalString(input.emailDigest),
          capability,
          status: 'fresh',
        },
        'bootstrap-redemption',
      ) as BootstrapRedemptionCapabilityState
      return frozen({
        expectedEpoch: epoch,
        authority: frozen({
          kind: 'host-bootstrap',
          mutation: 'redemption',
          authority: complete.capability,
        }),
      })
    },
    ownerRecoveryIssue(input) {
      const epoch = expectedEpoch(input.expectedEpoch)
      const capability = new PlatformHostInvocationAuthority<'owner-recovery-issue'>(
        authorityConstructionToken,
      )
      const complete = attachScope(
        {
          kind: 'owner-recovery-issue',
          expectedEpoch: epoch,
          expectedOwnerUserId: canonicalString(input.expectedOwnerUserId),
          hostInvocationId: canonicalString(input.hostInvocationId),
          capability,
          status: 'fresh',
        },
        'owner-recovery-issue',
      ) as OwnerRecoveryIssueCapabilityState
      return frozen({
        expectedEpoch: epoch,
        authority: frozen({
          kind: 'owner-recovery-issue',
          expectedOwnerUserId: complete.expectedOwnerUserId,
          invocation: complete.capability,
        }),
      })
    },
    expiredSessionMaintenance(input) {
      const epoch = expectedEpoch(input.expectedEpoch)
      const cursor = input.cursor === null ? null : canonicalString(input.cursor)
      if (
        !Number.isSafeInteger(input.batchSize) ||
        input.batchSize < 1 ||
        input.batchSize > 1_000
      ) {
        throw invalidInput()
      }
      const resolvedAccountUserIds = canonicalAccountIds(input.resolvedAccountUserIds)
      if (resolvedAccountUserIds.length > input.batchSize) throw invalidInput()
      const capability =
        new PlatformHostInvocationAuthority<'expired-session-maintenance'>(
          authorityConstructionToken,
        )
      const complete = attachScope(
        {
          kind: 'expired-session-maintenance',
          expectedEpoch: epoch,
          expectedOwnerUserId: canonicalString(input.expectedOwnerUserId),
          hostInvocationId: canonicalString(input.hostInvocationId),
          cursor,
          batchSize: input.batchSize,
          resolvedAccountUserIds,
          capability,
          status: 'fresh',
        },
        'expired-session-maintenance',
      ) as ExpiredSessionMaintenanceCapabilityState
      return frozen({
        expectedEpoch: epoch,
        authority: frozen({
          kind: 'expired-session-maintenance',
          cursor: complete.cursor,
          batchSize: complete.batchSize,
          invocation: complete.capability,
        }),
      })
    },
  }
}

function scopeState(scope: PlatformMutationAuthorityScope): ScopeState {
  const state = scopeStates.get(scope)
  if (!state?.active) throw staleAuthority()
  return state
}

function stateForAuthority(
  authority: MutationAuthority,
  epoch: InstallationMutationEpoch,
): CapabilityState {
  let state: CapabilityState | undefined
  switch (authority.kind) {
    case 'authenticated-session':
      state = capabilityStates.get(authority.session)
      if (
        state?.kind !== 'authenticated-session' ||
        authority.actorUserId !== state.actorUserId ||
        authority.expectedRole !== state.expectedRole
      ) {
        throw staleAuthority()
      }
      break
    case 'destructive-reauthentication-attempt':
      state = capabilityStates.get(authority.attempt)
      if (
        state?.kind !== authority.kind ||
        authority.actorUserId !== state.actorUserId ||
        authority.expectedRole !== state.expectedRole ||
        authority.session !== state.session ||
        authority.purpose !== state.purpose ||
        authority.targetUserId !== state.targetUserId
      ) {
        throw staleAuthority()
      }
      break
    case 'authenticated-destructive':
      state = capabilityStates.get(authority.reauthenticationLease)
      if (
        state?.kind !== authority.kind ||
        authority.actorUserId !== state.actorUserId ||
        authority.expectedRole !== state.expectedRole ||
        authority.session !== state.session ||
        authority.purpose !== state.purpose ||
        authority.targetUserId !== state.targetUserId
      ) {
        throw staleAuthority()
      }
      break
    case 'credential-lifecycle':
      state = capabilityStates.get(authority.authority)
      if (state?.kind !== authority.kind || state.mutation !== authority.mutation) {
        throw staleAuthority()
      }
      break
    case 'host-bootstrap':
      state = capabilityStates.get(authority.authority)
      if (state?.kind !== authority.kind || state.mutation !== authority.mutation) {
        throw staleAuthority()
      }
      break
    case 'owner-recovery-issue':
      state = capabilityStates.get(authority.invocation)
      if (
        state?.kind !== authority.kind ||
        state.expectedOwnerUserId !== authority.expectedOwnerUserId
      ) {
        throw staleAuthority()
      }
      break
    case 'expired-session-maintenance':
      state = capabilityStates.get(authority.invocation)
      if (
        state?.kind !== authority.kind ||
        state.cursor !== authority.cursor ||
        state.batchSize !== authority.batchSize
      ) {
        throw staleAuthority()
      }
      break
  }
  if (!state || state.expectedEpoch !== epoch) throw staleAuthority()
  return state
}

export function bindPlatformMutationAuthorityScope<Authority extends MutationAuthority>(
  issued: Issued<Authority>,
  operation: PrelockedSessionOperation,
): PlatformMutationAuthorityScope {
  const state = stateForAuthority(issued.authority, issued.expectedEpoch)
  if (state.kind === 'authenticated-session' || state.status !== 'fresh') {
    throw new CoordinationError('uow.prelocked-session-invalid')
  }
  const scope = scopeState(state.scope)
  if (scope.phase !== 'issued' || scope.operation !== operation) {
    throw new CoordinationError('uow.prelocked-session-invalid')
  }
  scope.phase = 'ready'
  return state.scope
}

export type PlatformCredentialPrelockPlan = Readonly<{
  readonly operation: PrelockedSessionOperation
  readonly lane: 'external-host' | 'submitted-email' | 'trusted'
  readonly instanceFence: 'exclusive' | 'shared'
  readonly emailDigest: string | null
  readonly accountUserIds: readonly string[]
  readonly unknownAccountEmailDigest: string | null
  readonly hostInvocationId: string | null
}>

function sortedDistinctAccountIds(values: readonly (string | null)[]): readonly string[] {
  return Object.freeze(
    [...new Set(values.filter((value): value is string => value !== null))].sort(),
  )
}

function credentialPrelockPlan(scope: ScopeState): PlatformCredentialPrelockPlan {
  const capability = scope.initialCapability
  let lane: PlatformCredentialPrelockPlan['lane'] = 'trusted'
  let instanceFence: PlatformCredentialPrelockPlan['instanceFence'] = 'shared'
  let emailDigest: string | null = null
  let accountUserIds: readonly string[] = Object.freeze([])
  let unknownAccountEmailDigest: string | null = null
  let hostInvocationId: string | null = null

  switch (capability.kind) {
    case 'destructive-reauthentication-attempt':
      instanceFence = capability.purpose === 'instance-reset' ? 'exclusive' : 'shared'
      emailDigest = capability.emailDigest
      accountUserIds = sortedDistinctAccountIds([
        capability.actorUserId,
        capability.targetUserId,
      ])
      break
    case 'authenticated-destructive':
      throw new CoordinationError('uow.prelocked-session-invalid')
    case 'credential-lifecycle':
      switch (capability.mutation) {
        case 'email-sign-in':
          lane = 'submitted-email'
          emailDigest = capability.emailDigest
          accountUserIds = capability.resolvedAccountUserIds
          if (accountUserIds.length === 0) {
            unknownAccountEmailDigest = capability.emailDigest
          }
          break
        case 'checked-sign-out':
          accountUserIds = Object.freeze([capability.resolvedAccountUserId])
          break
        case 'member-reset-redemption':
          lane = 'submitted-email'
          emailDigest = capability.emailDigest
          if (capability.targetUserId) {
            accountUserIds = Object.freeze([capability.targetUserId])
          } else {
            unknownAccountEmailDigest = capability.emailDigest
          }
          break
        case 'owner-recovery-web-redemption':
          if (!capability.targetUserId) {
            throw new CoordinationError('uow.prelocked-session-invalid')
          }
          lane = 'submitted-email'
          emailDigest = capability.emailDigest
          accountUserIds = Object.freeze([capability.targetUserId])
          break
        case 'owner-recovery-cli-redemption':
          if (!capability.targetUserId || !capability.hostInvocationId) {
            throw new CoordinationError('uow.prelocked-session-invalid')
          }
          lane = 'external-host'
          accountUserIds = Object.freeze([capability.targetUserId])
          hostInvocationId = capability.hostInvocationId
          break
      }
      break
    case 'host-bootstrap':
      if (capability.mutation === 'issuance') {
        lane = 'external-host'
        hostInvocationId = capability.hostInvocationId
      } else {
        emailDigest = capability.emailDigest
        accountUserIds = Object.freeze([capability.preallocatedOwnerUserId])
      }
      break
    case 'owner-recovery-issue':
      lane = 'external-host'
      hostInvocationId = capability.hostInvocationId
      accountUserIds = Object.freeze([capability.expectedOwnerUserId])
      break
    case 'expired-session-maintenance':
      lane = 'external-host'
      hostInvocationId = capability.hostInvocationId
      accountUserIds = capability.resolvedAccountUserIds
      break
  }

  return frozen({
    operation: scope.operation,
    lane,
    instanceFence,
    emailDigest,
    accountUserIds,
    unknownAccountEmailDigest,
    hostInvocationId,
  })
}

/** Consumed only by the exact Platform control-session adapter before any lease is exposed. */
export function consumePlatformCredentialPrelockPlan(
  authorityScope: PlatformMutationAuthorityScope,
): PlatformCredentialPrelockPlan {
  const scope = scopeStates.get(authorityScope)
  if (!scope?.active || scope.phase !== 'ready' || scope.prelockConsumed) {
    throw new CoordinationError('uow.prelocked-session-invalid')
  }
  const plan = credentialPrelockPlan(scope)
  scope.prelockConsumed = true
  return plan
}

export type CapturedIdentityAuthority =
  | (Omit<SessionReferenceState, 'expectedEpoch'> & {
      readonly expectedEpoch: InstallationMutationEpoch
    })
  | CapturedDestructiveAuthority
  | Readonly<{
      readonly kind: 'credential-lifecycle'
      readonly mutation: 'email-sign-in'
      readonly expectedEpoch: InstallationMutationEpoch
      readonly emailDigest: string
      readonly resolvedAccountUserIds: readonly string[]
    }>
  | Readonly<{
      readonly kind: 'credential-lifecycle'
      readonly mutation: 'checked-sign-out'
      readonly expectedEpoch: InstallationMutationEpoch
      readonly signedTokenDigest: string
      readonly resolvedAccountUserId: string
    }>
  | CapturedResetRedemptionAuthority
  | Readonly<{
      readonly kind: 'host-bootstrap'
      readonly mutation: 'issuance'
      readonly expectedEpoch: InstallationMutationEpoch
      readonly capabilityIdentity: string
      readonly hostInvocationId: string
    }>
  | Readonly<{
      readonly kind: 'host-bootstrap'
      readonly mutation: 'redemption'
      readonly expectedEpoch: InstallationMutationEpoch
      readonly capabilityIdentity: string
      readonly codeIdentity: string
      readonly preallocatedOwnerUserId: string
      readonly emailDigest: string
    }>
  | Readonly<{
      readonly kind: 'owner-recovery-issue'
      readonly expectedEpoch: InstallationMutationEpoch
      readonly expectedOwnerUserId: string
      readonly hostInvocationId: string
    }>
  | Readonly<{
      readonly kind: 'expired-session-maintenance'
      readonly expectedEpoch: InstallationMutationEpoch
      readonly expectedOwnerUserId: string
      readonly hostInvocationId: string
      readonly cursor: string | null
      readonly batchSize: number
      readonly resolvedAccountUserIds: readonly string[]
    }>

type CapturedDestructiveBindingByPurpose = {
  readonly 'trainee-data-deletion': {
    readonly expectedRole: IdentityRole
    readonly targetUserId: null
    readonly emailDigest: null
  }
  readonly 'instance-reset': {
    readonly expectedRole: 'owner'
    readonly targetUserId: null
    readonly emailDigest: null
  }
  readonly 'member-reset-issue': {
    readonly expectedRole: 'owner'
    readonly targetUserId: string
    readonly emailDigest: null
  }
  readonly 'local-user-create': {
    readonly expectedRole: 'owner'
    readonly targetUserId: string
    readonly emailDigest: string
  }
}

type CapturedDestructiveAuthority = {
  [Kind in 'destructive-reauthentication-attempt' | 'authenticated-destructive']: {
    [Purpose in DestructivePurpose]: Readonly<
      {
        readonly kind: Kind
        readonly expectedEpoch: InstallationMutationEpoch
        readonly actorUserId: string
        readonly sessionId: string
        readonly purpose: Purpose
      } & CapturedDestructiveBindingByPurpose[Purpose]
    >
  }[DestructivePurpose]
}['destructive-reauthentication-attempt' | 'authenticated-destructive']

type CapturedResetBindingByMutation = {
  readonly 'member-reset-redemption': {
    readonly emailDigest: string
    readonly hostInvocationId: null
    readonly targetUserId: string | null
    readonly channel: 'member'
  }
  readonly 'owner-recovery-web-redemption': {
    readonly emailDigest: string
    readonly hostInvocationId: null
    readonly targetUserId: string
    readonly channel: 'owner-web'
  }
  readonly 'owner-recovery-cli-redemption': {
    readonly emailDigest: null
    readonly hostInvocationId: string
    readonly targetUserId: string
    readonly channel: 'owner-cli'
  }
}

type CapturedResetRedemptionAuthority = {
  [Mutation in ResetRedemptionMutation]: Readonly<
    {
      readonly kind: 'credential-lifecycle'
      readonly mutation: Mutation
      readonly expectedEpoch: InstallationMutationEpoch
      readonly codeIdentity: string
    } & CapturedResetBindingByMutation[Mutation]
  >
}[ResetRedemptionMutation]

function capturedDestructiveAuthority(
  state: AttemptCapabilityState | ProtectedCapabilityState,
): CapturedDestructiveAuthority {
  const common = {
    kind: state.kind,
    expectedEpoch: state.expectedEpoch,
    actorUserId: state.actorUserId,
    sessionId: state.sessionId,
  } as const
  switch (state.purpose) {
    case 'trainee-data-deletion':
      if (state.targetUserId !== null || state.emailDigest !== null)
        throw staleAuthority()
      return frozen({
        ...common,
        purpose: state.purpose,
        expectedRole: state.expectedRole,
        targetUserId: null,
        emailDigest: null,
      })
    case 'instance-reset':
      if (
        state.expectedRole !== 'owner' ||
        state.targetUserId !== null ||
        state.emailDigest !== null
      ) {
        throw staleAuthority()
      }
      return frozen({
        ...common,
        purpose: state.purpose,
        expectedRole: state.expectedRole,
        targetUserId: null,
        emailDigest: null,
      })
    case 'member-reset-issue':
      if (
        state.expectedRole !== 'owner' ||
        state.targetUserId === null ||
        state.emailDigest !== null
      ) {
        throw staleAuthority()
      }
      return frozen({
        ...common,
        purpose: state.purpose,
        expectedRole: state.expectedRole,
        targetUserId: state.targetUserId,
        emailDigest: null,
      })
    case 'local-user-create':
      if (
        state.expectedRole !== 'owner' ||
        state.targetUserId === null ||
        state.emailDigest === null
      ) {
        throw staleAuthority()
      }
      return frozen({
        ...common,
        purpose: state.purpose,
        expectedRole: state.expectedRole,
        targetUserId: state.targetUserId,
        emailDigest: state.emailDigest,
      })
  }
}

function capturedResetRedemptionAuthority(
  state: ResetRedemptionCapabilityState,
): CapturedResetRedemptionAuthority {
  const common = {
    kind: state.kind,
    expectedEpoch: state.expectedEpoch,
    codeIdentity: state.codeIdentity,
  } as const
  switch (state.mutation) {
    case 'member-reset-redemption':
      if (
        state.emailDigest === null ||
        state.hostInvocationId !== null ||
        state.channel !== 'member'
      ) {
        throw staleAuthority()
      }
      return frozen({
        ...common,
        mutation: state.mutation,
        emailDigest: state.emailDigest,
        hostInvocationId: null,
        targetUserId: state.targetUserId,
        channel: state.channel,
      })
    case 'owner-recovery-web-redemption':
      if (
        state.emailDigest === null ||
        state.hostInvocationId !== null ||
        state.targetUserId === null ||
        state.channel !== 'owner-web'
      ) {
        throw staleAuthority()
      }
      return frozen({
        ...common,
        mutation: state.mutation,
        emailDigest: state.emailDigest,
        hostInvocationId: null,
        targetUserId: state.targetUserId,
        channel: state.channel,
      })
    case 'owner-recovery-cli-redemption':
      if (
        state.emailDigest !== null ||
        state.hostInvocationId === null ||
        state.targetUserId === null ||
        state.channel !== 'owner-cli'
      ) {
        throw staleAuthority()
      }
      return frozen({
        ...common,
        mutation: state.mutation,
        emailDigest: null,
        hostInvocationId: state.hostInvocationId,
        targetUserId: state.targetUserId,
        channel: state.channel,
      })
  }
}

function capturedAuthority(state: CapabilityState): CapturedIdentityAuthority {
  switch (state.kind) {
    case 'authenticated-session':
      return frozen({ ...state })
    case 'destructive-reauthentication-attempt':
    case 'authenticated-destructive':
      return capturedDestructiveAuthority(state)
    case 'credential-lifecycle':
      switch (state.mutation) {
        case 'email-sign-in':
          return frozen({
            kind: state.kind,
            mutation: state.mutation,
            expectedEpoch: state.expectedEpoch,
            emailDigest: state.emailDigest,
            resolvedAccountUserIds: state.resolvedAccountUserIds,
          })
        case 'checked-sign-out':
          return frozen({
            kind: state.kind,
            mutation: state.mutation,
            expectedEpoch: state.expectedEpoch,
            signedTokenDigest: state.signedTokenDigest,
            resolvedAccountUserId: state.resolvedAccountUserId,
          })
        default:
          return capturedResetRedemptionAuthority(state)
      }
    case 'host-bootstrap':
      return state.mutation === 'issuance'
        ? frozen({
            kind: state.kind,
            mutation: state.mutation,
            expectedEpoch: state.expectedEpoch,
            capabilityIdentity: state.capabilityIdentity,
            hostInvocationId: state.hostInvocationId,
          })
        : frozen({
            kind: state.kind,
            mutation: state.mutation,
            expectedEpoch: state.expectedEpoch,
            capabilityIdentity: state.capabilityIdentity,
            codeIdentity: state.codeIdentity,
            preallocatedOwnerUserId: state.preallocatedOwnerUserId,
            emailDigest: state.emailDigest,
          })
    case 'owner-recovery-issue':
      return frozen({
        kind: state.kind,
        expectedEpoch: state.expectedEpoch,
        expectedOwnerUserId: state.expectedOwnerUserId,
        hostInvocationId: state.hostInvocationId,
      })
    case 'expired-session-maintenance':
      return frozen({
        kind: state.kind,
        expectedEpoch: state.expectedEpoch,
        expectedOwnerUserId: state.expectedOwnerUserId,
        hostInvocationId: state.hostInvocationId,
        cursor: state.cursor,
        batchSize: state.batchSize,
        resolvedAccountUserIds: state.resolvedAccountUserIds,
      })
  }
}

type PreparedClaimState = {
  consumed: boolean
  readonly capability: CapabilityState
  readonly capturedAuthority: CapturedIdentityAuthority
  readonly prelockedScope: PlatformMutationAuthorityScope | null
}

const preparedClaims = new WeakMap<object, PreparedClaimState>()

/**
 * Performs provenance and exact public/hidden binding checks without spending the capability.
 * Multiple callers may prepare the same one-use proof; only the first synchronous consume wins.
 */
export function prepareMutationAuthorityClaim(
  request: UnitOfWorkRequest,
  expectedPrelockedOperation: PrelockedSessionOperation | null,
): void {
  if (preparedClaims.has(request)) throw staleAuthority()
  const capability = stateForAuthority(request.authority, request.expectedEpoch)
  if (
    request.operation === 'subject-deletion' &&
    (capability.kind !== 'authenticated-destructive' ||
      capability.purpose !== 'trainee-data-deletion' ||
      request.subjectLock?.subjectUserId !== capability.actorUserId)
  ) {
    throw staleAuthority()
  }
  let scope: PlatformMutationAuthorityScope | null = null
  if (expectedPrelockedOperation === null) {
    if (
      capability.kind !== 'authenticated-session' ||
      request.session.kind !== 'ordinary'
    ) {
      throw staleAuthority()
    }
  } else {
    if (
      capability.kind === 'authenticated-session' ||
      request.session.kind !== 'prelocked'
    ) {
      throw staleAuthority()
    }
    const state = scopeState(capability.scope)
    const validPhase =
      capability.kind === 'authenticated-destructive'
        ? state.phase === 'protected-ready' && capability.status === 'fresh'
        : state.phase === 'ready' && capability.status === 'fresh'
    if (
      state.operation !== expectedPrelockedOperation ||
      !state.prelockConsumed ||
      !validPhase
    )
      throw staleAuthority()
    scope = capability.scope
  }
  preparedClaims.set(request, {
    consumed: false,
    capability,
    capturedAuthority: capturedAuthority(capability),
    prelockedScope: scope,
  })
}

type ConsumedClaimState = PreparedClaimState & {
  active: boolean
  markedSuccessful: boolean
  promotedAuthority: AuthenticatedDestructiveAuthority | null
}

const consumedClaims = new WeakMap<object, ConsumedClaimState>()

export type ConsumedMutationAuthorityClaim = Readonly<{
  readonly capturedAuthority: CapturedIdentityAuthority
  readonly prelockedScope: PlatformMutationAuthorityScope | null
  assertActive(): void
  markReauthenticationSucceeded(): AuthenticatedDestructiveAuthority
  finish(outcome: { readonly committed: boolean }): void
}>

function claimIsActive(
  state: ConsumedClaimState | undefined,
): state is ConsumedClaimState {
  if (!state?.active) return false
  return (
    state.capability.kind === 'authenticated-session' ||
    scopeStates.get(state.capability.scope)?.active === true
  )
}

function consumeOneUse(state: OneUseCapabilityState): void {
  const scope = scopeState(state.scope)
  if (state.status !== 'fresh') throw staleAuthority()
  if (state.kind === 'authenticated-destructive') {
    if (scope.phase !== 'protected-ready') throw staleAuthority()
    scope.phase = 'protected-in-flight'
  } else if (state.kind === 'destructive-reauthentication-attempt') {
    if (scope.phase !== 'ready') throw staleAuthority()
    scope.phase = 'attempt-in-flight'
  } else {
    if (scope.phase !== 'ready') throw staleAuthority()
    scope.phase = 'direct-in-flight'
  }
  state.status = 'in-flight'
}

function markSuccessful(claim: ConsumedClaimState): AuthenticatedDestructiveAuthority {
  const state = claim.capability
  if (
    !claim.active ||
    claim.markedSuccessful ||
    state.kind !== 'destructive-reauthentication-attempt' ||
    state.status !== 'in-flight'
  ) {
    throw staleAuthority()
  }
  const scope = scopeState(state.scope)
  if (scope.phase !== 'attempt-in-flight') throw staleAuthority()
  const capability = new PlatformDestructiveLease<typeof state.purpose>(
    authorityConstructionToken,
  )
  const protectedState: ProtectedCapabilityState = {
    kind: 'authenticated-destructive',
    expectedEpoch: state.expectedEpoch,
    actorUserId: state.actorUserId,
    sessionId: state.sessionId,
    session: state.session,
    expectedRole: state.expectedRole,
    purpose: state.purpose,
    targetUserId: state.targetUserId,
    emailDigest: state.emailDigest,
    capability,
    scope: state.scope,
    status: 'pending',
  }
  capabilityStates.set(capability, protectedState)
  scope.pendingProtected = protectedState
  const authority = frozen({
    kind: 'authenticated-destructive',
    actorUserId: state.actorUserId,
    expectedRole: state.expectedRole,
    session: state.session,
    purpose: state.purpose,
    targetUserId: state.targetUserId,
    reauthenticationLease: capability,
  }) as AuthenticatedDestructiveAuthority
  claim.markedSuccessful = true
  claim.promotedAuthority = authority
  return authority
}

function finishClaim(claim: ConsumedClaimState, committed: boolean): void {
  if (!claim.active) return
  claim.active = false
  const capability = claim.capability
  if (capability.kind === 'authenticated-session') return
  capability.status = 'spent'
  const scope = scopeStates.get(capability.scope)
  if (!scope) return
  if (
    capability.kind === 'destructive-reauthentication-attempt' &&
    committed &&
    claim.markedSuccessful &&
    scope.pendingProtected?.status === 'pending' &&
    scope.active
  ) {
    scope.pendingProtected.status = 'fresh'
    scope.phase = 'protected-ready'
    return
  }
  if (scope.pendingProtected) scope.pendingProtected.status = 'spent'
  scope.phase = 'terminal'
}

class ConsumedClaim implements ConsumedMutationAuthorityClaim {
  constructor(token: typeof authorityConstructionToken, state: ConsumedClaimState) {
    if (token !== authorityConstructionToken) throw staleAuthority()
    consumedClaims.set(this, state)
  }

  get capturedAuthority(): CapturedIdentityAuthority {
    const state = consumedClaims.get(this)
    if (!claimIsActive(state)) throw staleAuthority()
    return state.capturedAuthority
  }

  get prelockedScope(): PlatformMutationAuthorityScope | null {
    const state = consumedClaims.get(this)
    if (!claimIsActive(state)) throw staleAuthority()
    return state.prelockedScope
  }

  assertActive(): void {
    if (!claimIsActive(consumedClaims.get(this))) throw staleAuthority()
  }

  markReauthenticationSucceeded(): AuthenticatedDestructiveAuthority {
    const state = consumedClaims.get(this)
    if (!state) throw staleAuthority()
    return markSuccessful(state)
  }

  finish({ committed }: { readonly committed: boolean }): void {
    const state = consumedClaims.get(this)
    if (state) finishClaim(state, committed)
  }
}

export function consumePreparedMutationAuthority(
  request: UnitOfWorkRequest,
): ConsumedMutationAuthorityClaim {
  const prepared = preparedClaims.get(request)
  if (!prepared || prepared.consumed) throw staleAuthority()
  prepared.consumed = true
  if (prepared.capability.kind !== 'authenticated-session') {
    consumeOneUse(prepared.capability)
  }
  return new ConsumedClaim(authorityConstructionToken, {
    ...prepared,
    active: true,
    markedSuccessful: false,
    promotedAuthority: null,
  })
}

export function assertPlatformMutationAuthorityScope(
  candidateScope: PlatformMutationAuthorityScope | null,
  expectedScope: PlatformMutationAuthorityScope,
  expectedOperation: PrelockedSessionOperation,
): void {
  const scope = scopeStates.get(expectedScope)
  const claimIsInFlight =
    scope?.phase === 'direct-in-flight' ||
    scope?.phase === 'attempt-in-flight' ||
    scope?.phase === 'protected-in-flight'
  if (
    candidateScope !== expectedScope ||
    !scope?.active ||
    !claimIsInFlight ||
    scope.operation !== expectedOperation
  ) {
    throw new CoordinationError('uow.prelocked-session-invalid')
  }
}

/** Unconditionally revokes every proof that shares an outer prelocked lease. */
export function revokePlatformMutationAuthorityScope(
  authorityScope: PlatformMutationAuthorityScope,
): void {
  const scope = scopeStates.get(authorityScope)
  if (!scope?.active) return
  scope.active = false
  scope.phase = 'terminal'
  scope.initialCapability.status = 'spent'
  if (scope.pendingProtected) scope.pendingProtected.status = 'spent'
}
