export type IdentityRole = 'owner' | 'member'

export type DestructivePurpose =
  | 'trainee-data-deletion'
  | 'instance-reset'
  | 'member-reset-issue'
  | 'local-user-create'

/** Opaque pre-queue installation lifecycle value captured by Identity. */
export abstract class InstallationMutationEpoch {
  protected declare readonly installationMutationEpochNominal: never

  protected constructor() {}
}

/** Future Stage 4 subject lifecycle value, kept nominally distinct from installation epoch. */
export abstract class SubjectDataGeneration {
  protected declare readonly subjectDataGenerationNominal: never

  protected constructor() {}
}

/** Signed-cookie-derived server-only session identity; it is never accepted from form data. */
export abstract class AuthenticatedSessionReference {
  protected declare readonly authenticatedSessionReferenceNominal: never

  protected constructor() {}
}

/** Sealed proof limiting writes to one purpose's attempt/lockout/audit path. */
export abstract class DestructiveReauthenticationAttempt<
  Purpose extends DestructivePurpose,
> {
  protected declare readonly destructiveReauthenticationAttemptNominal: Purpose

  protected constructor() {}
}

/** Purpose/actor/session/target-bound proof minted only after successful reauthentication. */
export abstract class DestructiveReauthenticationLease<
  Purpose extends DestructivePurpose,
> {
  protected declare readonly destructiveReauthenticationLeaseNominal: Purpose

  protected constructor() {}
}

export type CredentialLifecycleMutationKind =
  | 'email-sign-in'
  | 'checked-sign-out'
  | 'member-reset-redemption'
  | 'owner-recovery-web-redemption'
  | 'owner-recovery-cli-redemption'

/** Purpose-specific Identity credential-lifecycle proof. */
export abstract class CredentialLifecycleAuthority<
  Mutation extends CredentialLifecycleMutationKind,
> {
  protected declare readonly credentialLifecycleAuthorityNominal: Mutation

  protected constructor() {}
}

export type HostBootstrapMutationKind = 'issuance' | 'redemption'

/** Host-only bootstrap proof; issuance cannot be converted into redemption or vice versa. */
export abstract class HostBootstrapAuthority<Mutation extends HostBootstrapMutationKind> {
  protected declare readonly hostBootstrapAuthorityNominal: Mutation

  protected constructor() {}
}

export type HostInvocationKind = 'owner-recovery-issue' | 'expired-session-maintenance'

/** Host process identity sealed to one accepted operator command. */
export abstract class HostInvocationAuthority<Kind extends HostInvocationKind> {
  protected declare readonly hostInvocationAuthorityNominal: Kind

  protected constructor() {}
}

export type AuthenticatedSessionAuthority = {
  readonly kind: 'authenticated-session'
  readonly actorUserId: string
  readonly expectedRole: IdentityRole
  readonly session: AuthenticatedSessionReference
}

type DestructiveBindingByPurpose = {
  readonly 'trainee-data-deletion': {
    readonly expectedRole: IdentityRole
    readonly targetUserId: null
  }
  readonly 'instance-reset': {
    readonly expectedRole: 'owner'
    readonly targetUserId: null
  }
  readonly 'member-reset-issue': {
    readonly expectedRole: 'owner'
    readonly targetUserId: string
  }
  readonly 'local-user-create': {
    readonly expectedRole: 'owner'
    readonly targetUserId: string
  }
}

type DestructiveReauthenticationAttemptAuthorityFor<Purpose extends DestructivePurpose> =
  DestructiveBindingByPurpose[Purpose] & {
    readonly kind: 'destructive-reauthentication-attempt'
    readonly actorUserId: string
    readonly session: AuthenticatedSessionReference
    readonly purpose: Purpose
    readonly attempt: DestructiveReauthenticationAttempt<Purpose>
  }

export type DestructiveReauthenticationAttemptAuthority = {
  [Purpose in DestructivePurpose]: DestructiveReauthenticationAttemptAuthorityFor<Purpose>
}[DestructivePurpose]

type AuthenticatedDestructiveAuthorityFor<Purpose extends DestructivePurpose> =
  DestructiveBindingByPurpose[Purpose] & {
    readonly kind: 'authenticated-destructive'
    readonly actorUserId: string
    readonly session: AuthenticatedSessionReference
    readonly purpose: Purpose
    readonly reauthenticationLease: DestructiveReauthenticationLease<Purpose>
  }

export type AuthenticatedDestructiveAuthority = {
  [Purpose in DestructivePurpose]: AuthenticatedDestructiveAuthorityFor<Purpose>
}[DestructivePurpose]

type CredentialLifecycleMutationAuthorityFor<
  Mutation extends CredentialLifecycleMutationKind,
> = {
  readonly kind: 'credential-lifecycle'
  readonly mutation: Mutation
  readonly authority: CredentialLifecycleAuthority<Mutation>
}

export type CredentialLifecycleMutationAuthority = {
  [Mutation in CredentialLifecycleMutationKind]: CredentialLifecycleMutationAuthorityFor<Mutation>
}[CredentialLifecycleMutationKind]

type HostBootstrapMutationAuthorityFor<Mutation extends HostBootstrapMutationKind> = {
  readonly kind: 'host-bootstrap'
  readonly mutation: Mutation
  readonly authority: HostBootstrapAuthority<Mutation>
}

export type HostBootstrapMutationAuthority = {
  [Mutation in HostBootstrapMutationKind]: HostBootstrapMutationAuthorityFor<Mutation>
}[HostBootstrapMutationKind]

export type OwnerRecoveryIssueAuthority = {
  readonly kind: 'owner-recovery-issue'
  readonly expectedOwnerUserId: string
  readonly invocation: HostInvocationAuthority<'owner-recovery-issue'>
}

export type ExpiredSessionMaintenanceAuthority = {
  readonly kind: 'expired-session-maintenance'
  readonly cursor: string | null
  readonly batchSize: number
  readonly invocation: HostInvocationAuthority<'expired-session-maintenance'>
}

export type MutationAuthority =
  | AuthenticatedSessionAuthority
  | DestructiveReauthenticationAttemptAuthority
  | AuthenticatedDestructiveAuthority
  | CredentialLifecycleMutationAuthority
  | HostBootstrapMutationAuthority
  | OwnerRecoveryIssueAuthority
  | ExpiredSessionMaintenanceAuthority
