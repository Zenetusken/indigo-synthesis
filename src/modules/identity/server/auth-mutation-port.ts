import { createHmac } from 'node:crypto'
import { z } from 'zod'
import { getServerConfig } from '@/platform/config/server'
import { identityActionBindingHeader } from '../application/action-binding'
import { normalizeRecoveryEmail } from '../recovery/recovery-policy'

// Better Auth 1.6.23 accepts this syntactically valid address, while every supported Indigo
// account-creation path caps addresses at 254 characters. It therefore reaches the provider's
// real unknown-account lookup/hash path without being a creatable local identity.
const invalidProviderEmail = `${'i'.repeat(64)}@${'d'.repeat(63)}.${'u'.repeat(63)}.${'m'.repeat(63)}.com`

type EmailSignInMutationCommandState = Readonly<{
  actionBinding: unknown
  clientAddress: string
  credentialEmail: string
  providerRequest: Request
  rateLimitEmail: string
  syntacticallyValid: boolean
}>

const emailSignInMutationCommands = new WeakMap<
  EmailSignInMutationCommand,
  EmailSignInMutationCommandState
>()

/** Nominal, non-serializable sign-in input derived from exactly one external request. */
export abstract class EmailSignInMutationCommand {
  protected declare readonly emailSignInMutationCommandNominal: never
}

class ConcreteEmailSignInMutationCommand extends EmailSignInMutationCommand {}

export type EmailSignInMutationCommandView = EmailSignInMutationCommandState

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function dummyProviderPassword(): string {
  return createHmac('sha256', getServerConfig().authSecret)
    .update('sign-in-dummy-password-v1\0', 'utf8')
    .digest('base64url')
}

/**
 * Parses credentials once and derives the lock identity and provider request together. Invalid
 * inputs are mapped onto one non-creatable provider identity, so capture and mutation can never
 * disagree and every rejection still exercises Better Auth's unknown-account hash path.
 */
export async function createEmailSignInMutationCommand(input: {
  readonly actionBinding: unknown
  readonly clientAddress: string
  readonly request: Request
}): Promise<EmailSignInMutationCommand> {
  // Requests are mutable JavaScript objects. Freeze the externally supplied URL, headers,
  // body stream, and signal relationship before parsing yields so one command can never
  // combine credentials captured from one request state with provider headers from another.
  const request = new Request(input.request)
  let rawEmail: unknown
  let rawPassword: unknown
  let rawRememberMe: unknown
  try {
    if (
      request.headers.get('content-type')?.includes('application/x-www-form-urlencoded')
    ) {
      const body = await request.clone().formData()
      rawEmail = body.get('email')
      rawPassword = body.get('password')
      rawRememberMe = body.get('rememberMe')
    } else {
      const body: unknown = await request.clone().json()
      if (isRecord(body)) {
        rawEmail = body.email
        rawPassword = body.password
        rawRememberMe = body.rememberMe
      }
    }
  } catch {
    // Continue through the bounded dummy provider path.
  }

  const submittedEmail = normalizeRecoveryEmail(
    typeof rawEmail === 'string' ? rawEmail : 'invalid-email',
  )
  const validEmail = z.email().safeParse(submittedEmail).success
  const validPassword =
    typeof rawPassword === 'string' &&
    rawPassword.length <= 128 &&
    !rawPassword.includes('\0')
  const syntacticallyValid = validEmail && validPassword
  const credentialEmail = syntacticallyValid ? submittedEmail : invalidProviderEmail
  const headers = new Headers(request.headers)
  headers.delete('content-length')
  headers.delete(identityActionBindingHeader)
  headers.set('content-type', 'application/json')
  const rememberMe = rawRememberMe !== false && rawRememberMe !== 'false'

  const providerRequest = new Request(request.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email: credentialEmail,
      password: syntacticallyValid ? rawPassword : dummyProviderPassword(),
      rememberMe,
    }),
    signal: request.signal,
  })
  const state = Object.freeze({
    actionBinding: input.actionBinding,
    clientAddress: input.clientAddress,
    credentialEmail,
    providerRequest,
    rateLimitEmail: validEmail ? submittedEmail : invalidProviderEmail,
    syntacticallyValid,
  })
  const command = new ConcreteEmailSignInMutationCommand()
  emailSignInMutationCommands.set(command, state)
  Object.freeze(command)
  return command
}

export function emailSignInMutationCommandView(
  command: EmailSignInMutationCommand,
): EmailSignInMutationCommandView {
  const state = emailSignInMutationCommands.get(command)
  if (!state) throw new TypeError('Email sign-in command was not issued by Identity.')
  return state
}

/** Coarse server boundary for the two externally reachable credential mutations. */
export interface IdentityAuthMutationPort {
  emailSignIn(command: EmailSignInMutationCommand): Promise<Response>

  checkedSignOut(input: {
    readonly actionBinding: unknown
    readonly request: Request
    readonly signal?: AbortSignal
  }): Promise<Response>
}
