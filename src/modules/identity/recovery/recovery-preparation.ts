import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { getServerConfig } from '@/platform/config/server'
import { newUuidV7 } from '@/platform/ids/uuid-v7'
import { normalizeRecoveryEmail } from './recovery-policy'

const memberResetValueVersion = 'member-reset-v1'
const ownerRecoveryValueVersion = 'owner-recovery-v1'
const codeIdentityVersion = 'indigo-recovery-code-identity-v1'
const dummyDigestVersion = 'credential-dummy-v1'
const invalidSubmittedCode = 'indigo-invalid-recovery-code'
const invalidMemberPassword = 'indigo-invalid-member-reset-password'
const invalidOwnerPassword = 'indigo-invalid-owner-recovery-password'
const maximumCodeCharacters = 256
const maximumUuidTimestamp = 0xffffffffffff

type RecoveryCodePurpose = 'member-reset' | 'owner-recovery'

export const recoveryPreparationPolicy = Object.freeze({
  codeEntropyBytes: 32,
  maximumCodeCharacters,
  password: Object.freeze({ minimumCharacters: 12, maximumCharacters: 128 }),
  memberReset: Object.freeze({
    defaultTtlMinutes: 15,
    minimumTtlMinutes: 5,
    maximumTtlMinutes: 60,
    issuanceCooldownMilliseconds: 30_000,
  }),
  ownerRecovery: Object.freeze({
    minimumTtlMinutes: 5,
    maximumTtlMinutes: 60,
  }),
})

export class RecoveryPreparationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RecoveryPreparationError'
  }
}

export type ParsedRecoveryRedemptionInput = Readonly<{
  normalizedEmail: string
  submittedCode: string
  passwordHashInput: string
  passwordIsValid: boolean
}>

export type ParsedOwnerRecoveryIssuanceInput = Readonly<{
  normalizedOwnerEmail: string
  ttlMinutes: number
}>

export type PreparedRecoveryRedemption = Readonly<{
  auditEventId: string
  commandEnteredAt: Date
  normalizedEmail: string
  submittedCode: string
  codeIdentity: string
  passwordHash: string
  passwordIsValid: boolean
}>

export type PreparedMemberResetIssuance = Readonly<{
  resetId: string
  auditEventId: string
  targetUserId: string
  identifier: string
  code: string
  storedValue: string
  commandEnteredAt: Date
  expiresAt: Date
  audit: Readonly<{
    eventType: 'member-reset-issued'
    entityType: 'member-reset'
    entityId: string
    outcome: 'issued'
    expiresAt: string
  }>
}>

export type PreparedOwnerRecoveryIssuance = Readonly<{
  recoveryId: string
  auditEventId: string
  ownerUserId: string
  normalizedOwnerEmail: string
  identifier: string
  code: string
  storedValue: string
  commandEnteredAt: Date
  expiresAt: Date
  audit: Readonly<{
    eventType: 'owner-recovery-issued'
    entityType: 'owner-recovery'
    entityId: string
    channel: 'host-local-cli'
    outcome: 'issued'
    expiresAt: string
  }>
}>

function recoveryVersion(purpose: RecoveryCodePurpose): string {
  return purpose === 'member-reset' ? memberResetValueVersion : ownerRecoveryValueVersion
}

function boundedCode(code: unknown): Readonly<{ value: string; valid: boolean }> {
  const valid =
    typeof code === 'string' &&
    code.length >= 1 &&
    code.length <= maximumCodeCharacters &&
    !code.includes('\0')
  return Object.freeze({ value: valid ? code : invalidSubmittedCode, valid })
}

function digest(purpose: RecoveryCodePurpose, code: string): Buffer {
  return createHmac('sha256', getServerConfig().authSecret)
    .update(`${recoveryVersion(purpose)}\0${code}`, 'utf8')
    .digest()
}

function dummyDigest(): Buffer {
  return createHmac('sha256', getServerConfig().authSecret)
    .update(`${dummyDigestVersion}\0`, 'utf8')
    .digest()
}

function storedValue(purpose: RecoveryCodePurpose, code: string): string {
  return `${recoveryVersion(purpose)}:${digest(purpose, code).toString('hex')}`
}

function storedValueMatches(
  purpose: RecoveryCodePurpose,
  code: unknown,
  candidateStoredValue: unknown,
): boolean {
  const submitted = boundedCode(code)
  const prefix = `${recoveryVersion(purpose)}:`
  const candidateHex =
    typeof candidateStoredValue === 'string' && candidateStoredValue.startsWith(prefix)
      ? candidateStoredValue.slice(prefix.length)
      : ''
  const storedDigestIsValid = /^[0-9a-f]{64}$/.test(candidateHex)
  // Derive the fixed dummy on every path so a missing/malformed row does not skip a
  // cryptographic work class before the equal-length comparison.
  const fixedDummy = dummyDigest()
  const expected = storedDigestIsValid ? Buffer.from(candidateHex, 'hex') : fixedDummy
  const matches = timingSafeEqual(digest(purpose, submitted.value), expected)
  return submitted.valid && storedDigestIsValid && matches
}

function codeIdentity(purpose: RecoveryCodePurpose, code: unknown): string {
  const submitted = boundedCode(code)
  return createHmac('sha256', getServerConfig().authSecret)
    .update(`${codeIdentityVersion}\0${purpose}\0${submitted.value}`, 'utf8')
    .digest('hex')
}

function passwordInput(
  password: unknown,
  invalidPassword: string,
): Readonly<{ hashInput: string; valid: boolean }> {
  const valid =
    typeof password === 'string' &&
    password.length >= recoveryPreparationPolicy.password.minimumCharacters &&
    password.length <= recoveryPreparationPolicy.password.maximumCharacters &&
    !password.includes('\0')
  return Object.freeze({ hashInput: valid ? password : invalidPassword, valid })
}

function validateTtl(purpose: RecoveryCodePurpose, ttlMinutes: number): number {
  const policy =
    purpose === 'member-reset'
      ? recoveryPreparationPolicy.memberReset
      : recoveryPreparationPolicy.ownerRecovery
  if (
    !Number.isInteger(ttlMinutes) ||
    ttlMinutes < policy.minimumTtlMinutes ||
    ttlMinutes > policy.maximumTtlMinutes
  ) {
    throw new RecoveryPreparationError(
      `${purpose}.ttl-invalid`,
      `${purpose === 'member-reset' ? 'Reset' : 'Recovery'} lifetime must be a whole number from ${policy.minimumTtlMinutes} to ${policy.maximumTtlMinutes} minutes.`,
    )
  }
  return ttlMinutes
}

function expiry(commandEnteredAt: Date, ttlMinutes: number): Date {
  return new Date(commandEnteredAt.getTime() + ttlMinutes * 60_000)
}

function preparationId(commandEnteredAt: Date): string {
  return newUuidV7(commandEnteredAt.getTime())
}

export function captureRecoveryCommandEntry(now = new Date()): Date {
  const timestamp = now.getTime()
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > maximumUuidTimestamp) {
    throw new TypeError('The recovery command-entry clock must be a valid UUIDv7 date.')
  }
  return new Date(timestamp)
}

export function normalizeOwnerRecoveryEmail(email: unknown): string {
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : ''
  if (!normalized || normalized.length > 320 || !normalized.includes('@')) {
    throw new RecoveryPreparationError(
      'owner-recovery.owner-email-invalid',
      'Provide the installed owner email address.',
    )
  }
  return normalized
}

export function memberResetIdentifier(targetUserId: string): string {
  return `indigo:member-reset:${targetUserId}`
}

export function ownerRecoveryIdentifier(ownerUserId: string): string {
  return `indigo:owner-recovery:${ownerUserId}`
}

export function memberResetCodeIdentity(code: unknown): string {
  return codeIdentity('member-reset', code)
}

export function ownerRecoveryCodeIdentity(code: unknown): string {
  return codeIdentity('owner-recovery', code)
}

export function memberResetStoredValue(code: string): string {
  return storedValue('member-reset', code)
}

export function ownerRecoveryStoredValue(code: string): string {
  return storedValue('owner-recovery', code)
}

export function memberResetStoredValueMatches(
  code: unknown,
  candidateStoredValue: unknown,
): boolean {
  return storedValueMatches('member-reset', code, candidateStoredValue)
}

export function ownerRecoveryStoredValueMatches(
  code: unknown,
  candidateStoredValue: unknown,
): boolean {
  return storedValueMatches('owner-recovery', code, candidateStoredValue)
}

export function parseMemberResetRedemptionInput(input: {
  readonly email: unknown
  readonly code: unknown
  readonly newPassword: unknown
}): ParsedRecoveryRedemptionInput {
  const code = boundedCode(input.code)
  const password = passwordInput(input.newPassword, invalidMemberPassword)
  return Object.freeze({
    normalizedEmail: normalizeRecoveryEmail(input.email),
    submittedCode: code.value,
    passwordHashInput: password.hashInput,
    passwordIsValid: password.valid,
  })
}

export function parseOwnerRecoveryWebRedemptionInput(input: {
  readonly ownerEmail: unknown
  readonly code: unknown
  readonly newPassword: unknown
}): ParsedRecoveryRedemptionInput {
  const code = boundedCode(input.code)
  const password = passwordInput(input.newPassword, invalidOwnerPassword)
  return Object.freeze({
    normalizedEmail: normalizeRecoveryEmail(input.ownerEmail),
    submittedCode: code.value,
    passwordHashInput: password.hashInput,
    passwordIsValid: password.valid,
  })
}

export function parseOwnerRecoveryHostRedemptionInput(input: {
  readonly ownerEmail: unknown
  readonly code: unknown
  readonly newPassword: unknown
}): ParsedRecoveryRedemptionInput {
  const code = boundedCode(input.code)
  const password = passwordInput(input.newPassword, invalidOwnerPassword)
  if (!password.valid) {
    throw new RecoveryPreparationError(
      'owner-recovery.password-invalid',
      'The new password must contain 12 to 128 characters.',
    )
  }
  return Object.freeze({
    normalizedEmail: normalizeOwnerRecoveryEmail(input.ownerEmail),
    submittedCode: code.value,
    passwordHashInput: password.hashInput,
    passwordIsValid: true,
  })
}

export function parseOwnerRecoveryIssuanceInput(input: {
  readonly ownerEmail: unknown
  readonly ttlMinutes: number
}): ParsedOwnerRecoveryIssuanceInput {
  return Object.freeze({
    normalizedOwnerEmail: normalizeOwnerRecoveryEmail(input.ownerEmail),
    ttlMinutes: validateTtl('owner-recovery', input.ttlMinutes),
  })
}

export function prepareMemberResetIssuance(input: {
  readonly targetUserId: string
  readonly ttlMinutes?: number
  readonly commandEnteredAt: Date
}): PreparedMemberResetIssuance {
  const commandEnteredAt = captureRecoveryCommandEntry(input.commandEnteredAt)
  const ttlMinutes = validateTtl(
    'member-reset',
    input.ttlMinutes ?? recoveryPreparationPolicy.memberReset.defaultTtlMinutes,
  )
  const expiresAt = expiry(commandEnteredAt, ttlMinutes)
  const code = `indigo_m1_${randomBytes(recoveryPreparationPolicy.codeEntropyBytes).toString('base64url')}`
  const resetId = preparationId(commandEnteredAt)
  return Object.freeze({
    resetId,
    auditEventId: preparationId(commandEnteredAt),
    targetUserId: input.targetUserId,
    identifier: memberResetIdentifier(input.targetUserId),
    code,
    storedValue: memberResetStoredValue(code),
    commandEnteredAt,
    expiresAt,
    audit: Object.freeze({
      eventType: 'member-reset-issued',
      entityType: 'member-reset',
      entityId: resetId,
      outcome: 'issued',
      expiresAt: expiresAt.toISOString(),
    }),
  })
}

export function prepareOwnerRecoveryIssuance(input: {
  readonly ownerUserId: string
  readonly ownerEmail: unknown
  readonly ttlMinutes: number
  readonly commandEnteredAt: Date
}): PreparedOwnerRecoveryIssuance {
  const commandEnteredAt = captureRecoveryCommandEntry(input.commandEnteredAt)
  const parsed = parseOwnerRecoveryIssuanceInput({
    ownerEmail: input.ownerEmail,
    ttlMinutes: input.ttlMinutes,
  })
  const ttlMinutes = parsed.ttlMinutes
  const expiresAt = expiry(commandEnteredAt, ttlMinutes)
  const code = `indigo_r1_${randomBytes(recoveryPreparationPolicy.codeEntropyBytes).toString('base64url')}`
  const recoveryId = preparationId(commandEnteredAt)
  return Object.freeze({
    recoveryId,
    auditEventId: preparationId(commandEnteredAt),
    ownerUserId: input.ownerUserId,
    normalizedOwnerEmail: parsed.normalizedOwnerEmail,
    identifier: ownerRecoveryIdentifier(input.ownerUserId),
    code,
    storedValue: ownerRecoveryStoredValue(code),
    commandEnteredAt,
    expiresAt,
    audit: Object.freeze({
      eventType: 'owner-recovery-issued',
      entityType: 'owner-recovery',
      entityId: recoveryId,
      channel: 'host-local-cli',
      outcome: 'issued',
      expiresAt: expiresAt.toISOString(),
    }),
  })
}

async function prepareRedemption(
  purpose: RecoveryCodePurpose,
  parsed: ParsedRecoveryRedemptionInput,
  commandEnteredAtInput: Date,
): Promise<PreparedRecoveryRedemption> {
  const commandEnteredAt = captureRecoveryCommandEntry(commandEnteredAtInput)
  const passwordHash = await hashPassword(parsed.passwordHashInput)
  return Object.freeze({
    auditEventId: preparationId(commandEnteredAt),
    commandEnteredAt,
    normalizedEmail: parsed.normalizedEmail,
    submittedCode: parsed.submittedCode,
    codeIdentity: codeIdentity(purpose, parsed.submittedCode),
    passwordHash,
    passwordIsValid: parsed.passwordIsValid,
  })
}

export function prepareMemberResetRedemption(
  parsed: ParsedRecoveryRedemptionInput,
  commandEnteredAt: Date,
): Promise<PreparedRecoveryRedemption> {
  return prepareRedemption('member-reset', parsed, commandEnteredAt)
}

export function prepareOwnerRecoveryRedemption(
  parsed: ParsedRecoveryRedemptionInput,
  commandEnteredAt: Date,
): Promise<PreparedRecoveryRedemption> {
  return prepareRedemption('owner-recovery', parsed, commandEnteredAt)
}
