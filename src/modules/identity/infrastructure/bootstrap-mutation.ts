import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { QueryResult, QueryResultRow } from 'pg'
import {
  type CreatedOwner,
  OwnerBootstrapError,
  ownerBootstrapIdentifier,
  ownerBootstrapStoredValueMatches,
  type PreparedOwnerBootstrapIssuance,
  type PreparedOwnerBootstrapRedemption,
} from '@/modules/identity/bootstrap/owner-bootstrap'
import { account, auditEvents, user, verification } from '@/platform/db/schema'

const lifecycleValuePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const bootstrapSnapshotStatement = `
  SELECT
    installation.product_mutation_epoch::text AS product_mutation_epoch,
    installation.owner_user_id AS installation_owner_user_id,
    installation.bootstrap_closed_at AS bootstrap_closed_at,
    pending.id AS capability_id,
    pending.value AS capability_value,
    pending.expires_at AS capability_expires_at,
    pending.created_at AS capability_created_at,
    pending.updated_at AS capability_updated_at
  FROM installation_state AS installation
  LEFT JOIN verification AS pending
    ON pending.identifier = $1
  WHERE installation.singleton = 1
`

export type IdentityBootstrapMutationQuery = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>
}

type CapabilitySnapshot = Readonly<{
  id: string
  value: string
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
}>

type BootstrapSnapshot = Readonly<{
  expectedEpoch: string
  ownerUserId: string | null
  bootstrapClosedAt: Date | null
  capability: CapabilitySnapshot | null
}>

type IssuanceCaptureState = Readonly<{ snapshot: BootstrapSnapshot }>
type RedemptionCaptureState = Readonly<{
  snapshot: BootstrapSnapshot
  code: string
  now: Date
}>

const issuanceCaptures = new WeakMap<
  OwnerBootstrapIssuanceCapture,
  IssuanceCaptureState
>()
const redemptionCaptures = new WeakMap<
  OwnerBootstrapRedemptionCapture,
  RedemptionCaptureState
>()

/** Nominal evidence for one coherent open-installation issuance snapshot. */
export abstract class OwnerBootstrapIssuanceCapture {
  protected constructor() {}
}

/** Nominal evidence for one coherent installation/capability redemption snapshot. */
export abstract class OwnerBootstrapRedemptionCapture {
  protected constructor() {}
}

const bootstrapCaptureToken = Object.freeze({})

class ConcreteOwnerBootstrapIssuanceCapture extends OwnerBootstrapIssuanceCapture {
  constructor(_token: typeof bootstrapCaptureToken) {
    super()
  }
}
class ConcreteOwnerBootstrapRedemptionCapture extends OwnerBootstrapRedemptionCapture {
  constructor(_token: typeof bootstrapCaptureToken) {
    super()
  }
}

type BootstrapSnapshotRow = QueryResultRow & {
  readonly product_mutation_epoch?: unknown
  readonly installation_owner_user_id?: unknown
  readonly bootstrap_closed_at?: unknown
  readonly capability_id?: unknown
  readonly capability_value?: unknown
  readonly capability_expires_at?: unknown
  readonly capability_created_at?: unknown
  readonly capability_updated_at?: unknown
}

function invariant(): never {
  throw new Error('Identity bootstrap capture returned an invalid database shape.')
}

function identity(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
    return invariant()
  }
  return value
}

function date(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return invariant()
  return value
}

function capabilitySnapshot(row: BootstrapSnapshotRow): CapabilitySnapshot | null {
  const fields = [
    row.capability_id,
    row.capability_value,
    row.capability_expires_at,
    row.capability_created_at,
    row.capability_updated_at,
  ]
  if (fields.every((value) => value === null)) return null
  if (fields.some((value) => value === null || value === undefined)) return invariant()
  return Object.freeze({
    id: identity(row.capability_id),
    value: identity(row.capability_value),
    expiresAt: date(row.capability_expires_at),
    createdAt: date(row.capability_created_at),
    updatedAt: date(row.capability_updated_at),
  })
}

async function readSnapshot(
  query: IdentityBootstrapMutationQuery,
): Promise<BootstrapSnapshot> {
  const result = await query.query<BootstrapSnapshotRow>(bootstrapSnapshotStatement, [
    ownerBootstrapIdentifier,
  ])
  if (result.rows.length !== 1) {
    throw new OwnerBootstrapError(
      'owner-bootstrap.installation-missing',
      'The installation state is unavailable. Run the current database migrations.',
    )
  }
  const row = result.rows[0]
  if (
    !row ||
    typeof row.product_mutation_epoch !== 'string' ||
    !lifecycleValuePattern.test(row.product_mutation_epoch) ||
    (row.installation_owner_user_id !== null &&
      typeof row.installation_owner_user_id !== 'string') ||
    (row.bootstrap_closed_at !== null && !(row.bootstrap_closed_at instanceof Date))
  ) {
    return invariant()
  }
  if ((row.installation_owner_user_id === null) !== (row.bootstrap_closed_at === null)) {
    return invariant()
  }
  return Object.freeze({
    expectedEpoch: row.product_mutation_epoch,
    ownerUserId: row.installation_owner_user_id,
    bootstrapClosedAt: row.bootstrap_closed_at,
    capability: capabilitySnapshot(row),
  })
}

function assertOpen(snapshot: BootstrapSnapshot): void {
  if (snapshot.ownerUserId !== null || snapshot.bootstrapClosedAt !== null) {
    throw new OwnerBootstrapError(
      'owner-bootstrap.instance-closed',
      'This installation already has an owner.',
    )
  }
}

function assertCapability(snapshot: BootstrapSnapshot, code: string, now: Date): void {
  const pending = snapshot.capability
  if (
    !pending ||
    pending.expiresAt <= now ||
    !ownerBootstrapStoredValueMatches(code, pending.value)
  ) {
    throw new OwnerBootstrapError(
      'owner-bootstrap.capability-invalid',
      'The bootstrap code is invalid or expired.',
    )
  }
}

function sameCapability(
  left: CapabilitySnapshot | null,
  right: CapabilitySnapshot | null,
): boolean {
  if (!left || !right) return left === right
  return (
    left.id === right.id &&
    left.value === right.value &&
    left.expiresAt.getTime() === right.expiresAt.getTime() &&
    left.createdAt.getTime() === right.createdAt.getTime() &&
    left.updatedAt.getTime() === right.updatedAt.getTime()
  )
}

function sameInstallation(left: BootstrapSnapshot, right: BootstrapSnapshot): boolean {
  return (
    left.expectedEpoch === right.expectedEpoch &&
    left.ownerUserId === right.ownerUserId &&
    left.bootstrapClosedAt?.getTime() === right.bootstrapClosedAt?.getTime()
  )
}

export async function captureOwnerBootstrapIssuance(
  query: IdentityBootstrapMutationQuery,
): Promise<OwnerBootstrapIssuanceCapture> {
  const snapshot = await readSnapshot(query)
  assertOpen(snapshot)
  const capture = new ConcreteOwnerBootstrapIssuanceCapture(bootstrapCaptureToken)
  issuanceCaptures.set(capture, Object.freeze({ snapshot }))
  Object.freeze(capture)
  return capture
}

export async function captureOwnerBootstrapRedemption(
  query: IdentityBootstrapMutationQuery,
  input: { readonly code: string; readonly now: Date },
): Promise<OwnerBootstrapRedemptionCapture> {
  const snapshot = await readSnapshot(query)
  assertOpen(snapshot)
  assertCapability(snapshot, input.code, input.now)
  const capture = new ConcreteOwnerBootstrapRedemptionCapture(bootstrapCaptureToken)
  redemptionCaptures.set(
    capture,
    Object.freeze({ snapshot, code: input.code, now: input.now }),
  )
  Object.freeze(capture)
  return capture
}

export function ownerBootstrapIssuanceCaptureView(
  capture: OwnerBootstrapIssuanceCapture,
): Readonly<{ expectedEpoch: string }> {
  const state = issuanceCaptures.get(capture)
  if (!state)
    throw new TypeError('Bootstrap issuance capture was not issued by Identity.')
  return Object.freeze({ expectedEpoch: state.snapshot.expectedEpoch })
}

export function ownerBootstrapRedemptionCaptureView(
  capture: OwnerBootstrapRedemptionCapture,
): Readonly<{ expectedEpoch: string; capabilityId: string }> {
  const state = redemptionCaptures.get(capture)
  if (!state?.snapshot.capability) {
    throw new TypeError('Bootstrap redemption capture was not issued by Identity.')
  }
  return Object.freeze({
    expectedEpoch: state.snapshot.expectedEpoch,
    capabilityId: state.snapshot.capability.id,
  })
}

export async function recheckOwnerBootstrapIssuance(
  query: IdentityBootstrapMutationQuery,
  capture: OwnerBootstrapIssuanceCapture,
): Promise<void> {
  const expected = issuanceCaptures.get(capture)
  if (!expected)
    throw new TypeError('Bootstrap issuance capture was not issued by Identity.')
  const current = await readSnapshot(query)
  assertOpen(current)
  if (
    !sameInstallation(current, expected.snapshot) ||
    !sameCapability(current.capability, expected.snapshot.capability)
  ) {
    throw new OwnerBootstrapError(
      'owner-bootstrap.authority-stale',
      'The installation changed before bootstrap issuance committed.',
    )
  }
}

export async function recheckOwnerBootstrapRedemption(
  query: IdentityBootstrapMutationQuery,
  capture: OwnerBootstrapRedemptionCapture,
): Promise<void> {
  const expected = redemptionCaptures.get(capture)
  if (!expected)
    throw new TypeError('Bootstrap redemption capture was not issued by Identity.')
  const current = await readSnapshot(query)
  assertOpen(current)
  assertCapability(current, expected.code, expected.now)
  if (
    !sameInstallation(current, expected.snapshot) ||
    !sameCapability(current.capability, expected.snapshot.capability)
  ) {
    throw new OwnerBootstrapError(
      'owner-bootstrap.authority-stale',
      'The installation or bootstrap capability changed before redemption committed.',
    )
  }
}

export interface ScopedIdentityBootstrapMutationGateway {
  issue(prepared: PreparedOwnerBootstrapIssuance): Promise<void>
  redeem(
    capture: OwnerBootstrapRedemptionCapture,
    prepared: PreparedOwnerBootstrapRedemption,
  ): Promise<CreatedOwner>
}

export function createScopedIdentityBootstrapMutationGateway<
  TSchema extends Record<string, unknown>,
>(database: NodePgDatabase<TSchema>): ScopedIdentityBootstrapMutationGateway {
  return Object.freeze({
    async issue(prepared: PreparedOwnerBootstrapIssuance) {
      await database
        .delete(verification)
        .where(eq(verification.identifier, ownerBootstrapIdentifier))
      await database.insert(verification).values({
        id: prepared.capabilityId,
        identifier: ownerBootstrapIdentifier,
        value: prepared.storedValue,
        expiresAt: prepared.expiresAt,
        createdAt: prepared.createdAt,
        updatedAt: prepared.createdAt,
      })
      await database.insert(auditEvents).values({
        id: prepared.auditEventId,
        actorUserId: null,
        subjectUserId: null,
        eventType: 'owner-bootstrap-issued',
        entityType: 'owner-bootstrap',
        entityId: prepared.capabilityId,
        metadata: {
          channel: 'host-local-cli',
          expiresAt: prepared.expiresAt.toISOString(),
        },
        createdAt: prepared.createdAt,
      })
    },
    async redeem(
      capture: OwnerBootstrapRedemptionCapture,
      prepared: PreparedOwnerBootstrapRedemption,
    ) {
      const state = redemptionCaptures.get(capture)
      const capability = state?.snapshot.capability
      if (!capability) {
        throw new TypeError('Bootstrap redemption capture was not issued by Identity.')
      }
      const [created] = await database
        .insert(user)
        .values({
          id: prepared.ownerUserId,
          name: prepared.name,
          email: prepared.email,
          emailVerified: false,
          createdAt: prepared.createdAt,
          updatedAt: prepared.createdAt,
        })
        .returning({ id: user.id, name: user.name, email: user.email })
      if (!created) {
        throw new OwnerBootstrapError(
          'owner-bootstrap.creation-failed',
          'The owner account could not be created.',
        )
      }
      await database.insert(account).values({
        id: prepared.accountId,
        accountId: prepared.ownerUserId,
        providerId: 'credential',
        userId: prepared.ownerUserId,
        password: prepared.passwordHash,
        createdAt: prepared.createdAt,
        updatedAt: prepared.createdAt,
      })
      const consumed = await database
        .delete(verification)
        .where(
          and(
            eq(verification.id, capability.id),
            eq(verification.identifier, ownerBootstrapIdentifier),
          ),
        )
        .returning({ id: verification.id })
      if (consumed.length !== 1) {
        throw new OwnerBootstrapError(
          'owner-bootstrap.capability-invalid',
          'The bootstrap code is invalid or expired.',
        )
      }
      await database.insert(auditEvents).values({
        id: prepared.auditEventId,
        actorUserId: prepared.ownerUserId,
        subjectUserId: prepared.ownerUserId,
        eventType: 'owner-bootstrap-completed',
        entityType: 'installation',
        entityId: '1',
        metadata: { channel: 'host-issued-browser-capability' },
        createdAt: prepared.createdAt,
      })
      return created
    },
  })
}
