import { z } from 'zod'
import { type AuthenticatedActor, assertOwner } from './actor'

const localUserInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(12).max(128),
})

export type CreateLocalUserInput = z.input<typeof localUserInputSchema>

export type ValidatedLocalUserInput = z.output<typeof localUserInputSchema>

export type LocalUser = {
  readonly id: string
  readonly name: string
  readonly email: string
}

export type LocalUserSummary = LocalUser & {
  readonly createdAt: Date
}

export interface LocalUserCreator {
  create(ownerUserId: string, input: ValidatedLocalUserInput): Promise<LocalUser>
}

export interface LocalUserReader {
  list(): Promise<readonly LocalUserSummary[]>
}

export class LocalUserInputError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid local user: ${issues.join('; ')}`)
    this.name = 'LocalUserInputError'
  }
}

export class LocalUserEmailConflictError extends Error {
  constructor() {
    super('A local user with that email already exists.')
    this.name = 'LocalUserEmailConflictError'
  }
}

export class LocalUserCredentialError extends Error {
  constructor(readonly code: string) {
    super('The owner credential was not accepted for local-user creation.')
    this.name = 'LocalUserCredentialError'
  }
}

export function validateLocalUserInput(
  input: CreateLocalUserInput,
): ValidatedLocalUserInput {
  const parsed = localUserInputSchema.safeParse(input)

  if (!parsed.success) {
    throw new LocalUserInputError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    )
  }

  return parsed.data
}

export async function createLocalUser(
  actor: AuthenticatedActor,
  input: CreateLocalUserInput,
  creator: LocalUserCreator,
): Promise<LocalUser> {
  assertOwner(actor)
  return creator.create(actor.userId, validateLocalUserInput(input))
}

export async function listLocalUsers(
  actor: AuthenticatedActor,
  reader: LocalUserReader,
): Promise<readonly LocalUserSummary[]> {
  assertOwner(actor)
  return reader.list()
}
