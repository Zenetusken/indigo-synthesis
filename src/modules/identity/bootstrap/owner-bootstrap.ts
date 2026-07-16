import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { z } from 'zod'
import { getServerConfig } from '@/platform/config/server'
import { newUuidV7 } from '@/platform/ids/uuid-v7'

export const ownerBootstrapIdentifier = 'indigo:owner-bootstrap'
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

export type PreparedOwnerBootstrapIssuance = IssuedOwnerBootstrap & {
  readonly auditEventId: string
  readonly createdAt: Date
  readonly storedValue: string
}

export type ParsedOwnerBootstrapInput = Readonly<{
  name: string
  email: string
  password: string
  code: string
}>

export type PreparedOwnerBootstrapRedemption = Readonly<{
  ownerUserId: string
  accountId: string
  auditEventId: string
  name: string
  email: string
  passwordHash: string
  codeIdentity: string
  createdAt: Date
}>

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

export function ownerBootstrapCodeIdentity(code: string): string {
  return bootstrapDigest(code)
}

export function ownerBootstrapStoredValueMatches(
  code: string,
  storedValue: string,
): boolean {
  const prefix = `${bootstrapValueVersion}:`
  if (!storedValue.startsWith(prefix)) return false

  const expectedHex = storedValue.slice(prefix.length)
  if (!/^[0-9a-f]{64}$/.test(expectedHex)) return false
  const actualHex = bootstrapDigest(code)
  return timingSafeEqual(Buffer.from(actualHex, 'hex'), Buffer.from(expectedHex, 'hex'))
}

export function prepareOwnerBootstrapIssuance(input: {
  readonly ttlMinutes: number
  readonly now?: Date
}): PreparedOwnerBootstrapIssuance {
  validateTtlMinutes(input.ttlMinutes)
  const createdAt = input.now ?? new Date()
  const expiresAt = new Date(createdAt.getTime() + input.ttlMinutes * 60_000)
  const code = `indigo_b1_${randomBytes(32).toString('base64url')}`
  return Object.freeze({
    capabilityId: newUuidV7(),
    auditEventId: newUuidV7(),
    code,
    createdAt,
    expiresAt,
    storedValue: `${bootstrapValueVersion}:${bootstrapDigest(code)}`,
  })
}

export function parseOwnerBootstrapInput(
  rawInput: z.input<typeof ownerInputSchema>,
): ParsedOwnerBootstrapInput {
  const parsed = ownerInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new OwnerBootstrapError(
      'owner-bootstrap.input-invalid',
      'Provide a valid name, email, password, and host-issued bootstrap code.',
    )
  }
  return Object.freeze(parsed.data)
}

export async function prepareOwnerBootstrapRedemption(
  input: ParsedOwnerBootstrapInput,
  createdAt: Date,
): Promise<PreparedOwnerBootstrapRedemption> {
  const passwordHash = await hashPassword(input.password)
  return Object.freeze({
    ownerUserId: newUuidV7(),
    accountId: newUuidV7(),
    auditEventId: newUuidV7(),
    name: input.name,
    email: input.email,
    passwordHash,
    codeIdentity: ownerBootstrapCodeIdentity(input.code),
    createdAt,
  })
}
