import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getServerConfig } from '@/platform/config/server'
import { type DatabaseTransaction, getDb } from '@/platform/db/client'
import {
  account,
  auditEvents,
  installationState,
  user,
  verification,
} from '@/platform/db/schema'
import { newUuidV7 } from '@/platform/ids/uuid-v7'

const bootstrapIdentifier = 'indigo:owner-bootstrap'
const bootstrapValueVersion = 'owner-bootstrap-v1'
const minimumTtlMinutes = 5
const maximumTtlMinutes = 60

const ownerInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(12).max(128),
  code: z.string().trim().min(32).max(256),
})

export class OwnerBootstrapError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'OwnerBootstrapError'
  }
}

export type IssuedOwnerBootstrap = {
  readonly capabilityId: string
  readonly code: string
  readonly expiresAt: Date
}

export type CreatedOwner = {
  readonly id: string
  readonly name: string
  readonly email: string
}

function validateTtlMinutes(ttlMinutes: number): void {
  if (
    !Number.isInteger(ttlMinutes) ||
    ttlMinutes < minimumTtlMinutes ||
    ttlMinutes > maximumTtlMinutes
  ) {
    throw new OwnerBootstrapError(
      'owner-bootstrap.ttl-invalid',
      `Bootstrap lifetime must be a whole number from ${minimumTtlMinutes} to ${maximumTtlMinutes} minutes.`,
    )
  }
}

function bootstrapDigest(code: string): string {
  return createHmac('sha256', getServerConfig().authSecret)
    .update(`${bootstrapValueVersion}\0${code}`, 'utf8')
    .digest('hex')
}

function storedBootstrapValue(code: string): string {
  return `${bootstrapValueVersion}:${bootstrapDigest(code)}`
}

function codeMatchesStoredValue(code: string, storedValue: string): boolean {
  const prefix = `${bootstrapValueVersion}:`
  if (!storedValue.startsWith(prefix)) return false

  const expectedHex = storedValue.slice(prefix.length)
  if (!/^[0-9a-f]{64}$/.test(expectedHex)) return false
  const actualHex = bootstrapDigest(code)
  return timingSafeEqual(Buffer.from(actualHex, 'hex'), Buffer.from(expectedHex, 'hex'))
}

async function ensureOpenInstallation(database: DatabaseTransaction) {
  const [installation] = await database
    .select()
    .from(installationState)
    .where(eq(installationState.singleton, 1))
    .for('update')
    .limit(1)

  if (!installation) {
    throw new OwnerBootstrapError(
      'owner-bootstrap.installation-missing',
      'The installation state is unavailable. Run the current database migrations.',
    )
  }

  if (installation.ownerUserId || installation.bootstrapClosedAt) {
    throw new OwnerBootstrapError(
      'owner-bootstrap.instance-closed',
      'This installation already has an owner.',
    )
  }

  return installation
}

function assertCapability(
  pending: typeof verification.$inferSelect | undefined,
  code: string,
  now: Date,
): asserts pending is typeof verification.$inferSelect {
  if (
    !pending ||
    pending.expiresAt <= now ||
    !codeMatchesStoredValue(code, pending.value)
  ) {
    throw new OwnerBootstrapError(
      'owner-bootstrap.capability-invalid',
      'The bootstrap code is invalid or expired.',
    )
  }
}

export async function issueOwnerBootstrap(input: {
  readonly ttlMinutes: number
  readonly now?: Date
}): Promise<IssuedOwnerBootstrap> {
  validateTtlMinutes(input.ttlMinutes)
  const now = input.now ?? new Date()
  const expiresAt = new Date(now.getTime() + input.ttlMinutes * 60_000)
  const code = `indigo_b1_${randomBytes(32).toString('base64url')}`

  return getDb().transaction(
    async (transaction) => {
      await ensureOpenInstallation(transaction)
      await transaction
        .delete(verification)
        .where(eq(verification.identifier, bootstrapIdentifier))

      const capabilityId = newUuidV7()
      await transaction.insert(verification).values({
        id: capabilityId,
        identifier: bootstrapIdentifier,
        value: storedBootstrapValue(code),
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      await transaction.insert(auditEvents).values({
        id: newUuidV7(),
        actorUserId: null,
        subjectUserId: null,
        eventType: 'owner-bootstrap-issued',
        entityType: 'owner-bootstrap',
        entityId: capabilityId,
        metadata: {
          channel: 'host-local-cli',
          expiresAt: expiresAt.toISOString(),
        },
        createdAt: now,
      })

      return { capabilityId, code, expiresAt }
    },
    { isolationLevel: 'serializable' },
  )
}

async function preflightCapability(code: string, now: Date): Promise<void> {
  const [installation] = await getDb()
    .select({ ownerUserId: installationState.ownerUserId })
    .from(installationState)
    .where(eq(installationState.singleton, 1))
    .limit(1)
  if (installation?.ownerUserId) {
    throw new OwnerBootstrapError(
      'owner-bootstrap.instance-closed',
      'This installation already has an owner.',
    )
  }

  const [pending] = await getDb()
    .select()
    .from(verification)
    .where(eq(verification.identifier, bootstrapIdentifier))
    .limit(1)
  assertCapability(pending, code, now)
}

export async function createOwnerWithBootstrapCode(
  rawInput: z.input<typeof ownerInputSchema> & { readonly now?: Date },
): Promise<CreatedOwner> {
  const parsed = ownerInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new OwnerBootstrapError(
      'owner-bootstrap.input-invalid',
      'Provide a valid name, email, password, and host-issued bootstrap code.',
    )
  }

  const now = rawInput.now ?? new Date()
  await preflightCapability(parsed.data.code, now)
  const passwordHash = await hashPassword(parsed.data.password)

  return getDb().transaction(
    async (transaction) => {
      await ensureOpenInstallation(transaction)
      const [pending] = await transaction
        .select()
        .from(verification)
        .where(eq(verification.identifier, bootstrapIdentifier))
        .for('update')
        .limit(1)
      assertCapability(pending, parsed.data.code, now)

      await transaction.execute(
        "SELECT set_config('indigo.user_creation_mode', 'bootstrap-owner', true)",
      )

      const ownerId = newUuidV7()
      const [created] = await transaction
        .insert(user)
        .values({
          id: ownerId,
          name: parsed.data.name,
          email: parsed.data.email,
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: user.id, name: user.name, email: user.email })
      if (!created) {
        throw new OwnerBootstrapError(
          'owner-bootstrap.creation-failed',
          'The owner account could not be created.',
        )
      }

      await transaction.insert(account).values({
        id: newUuidV7(),
        accountId: ownerId,
        providerId: 'credential',
        userId: ownerId,
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      })
      await transaction.delete(verification).where(eq(verification.id, pending.id))
      await transaction.insert(auditEvents).values({
        id: newUuidV7(),
        actorUserId: ownerId,
        subjectUserId: ownerId,
        eventType: 'owner-bootstrap-completed',
        entityType: 'installation',
        entityId: '1',
        metadata: { channel: 'host-issued-browser-capability' },
        createdAt: now,
      })

      return created
    },
    { isolationLevel: 'serializable' },
  )
}
