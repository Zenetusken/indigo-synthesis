import { isAbsolute, resolve } from 'node:path'
import {
  issueOwnerRecoveryFromHostCli,
  redeemOwnerRecoveryFromHostCli,
} from '@/composition/identity-host-recovery-mutations'
import { OwnerRecoveryError } from '@/modules/identity/recovery/owner-recovery-contract'
import {
  createOwnerSecretFile,
  openOwnerSecretFile,
} from '@/platform/security/owner-secret-file'

const recoveryCodeFileLimitBytes = 256
const passwordFileLimitBytes = 1_024

const usage = `Usage:
  pnpm owner:recover issue --owner-email EMAIL --code-file ABSOLUTE_PATH --ttl-minutes 15
  pnpm owner:recover redeem --owner-email EMAIL --code-file ABSOLUTE_PATH --password-file ABSOLUTE_PATH

Secrets are accepted only through owner-owned files in protected directories, never command arguments.`

type ParsedCommand =
  | {
      readonly kind: 'issue'
      readonly ownerEmail: string
      readonly codeFile: string
      readonly ttlMinutes: number
    }
  | {
      readonly kind: 'redeem'
      readonly ownerEmail: string
      readonly codeFile: string
      readonly passwordFile: string
    }

function parseOptions(arguments_: readonly string[]): Map<string, string> {
  const options = new Map<string, string>()
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]
    const value = arguments_[index + 1]
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(usage)
    }
    if (options.has(name)) throw new Error(`Option ${name} was supplied more than once.`)
    options.set(name, value)
  }
  return options
}

function requiredOption(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name)
  if (!value) throw new Error(`Missing ${name}.\n\n${usage}`)
  return value
}

function requireAbsoluteFilePath(value: string, optionName: string): string {
  if (!isAbsolute(value)) {
    throw new Error(`${optionName} must be an absolute local path.`)
  }
  return resolve(value)
}

function rejectUnknownOptions(
  options: ReadonlyMap<string, string>,
  allowed: ReadonlySet<string>,
): void {
  for (const name of options.keys()) {
    if (!allowed.has(name)) throw new Error(`Unknown option ${name}.\n\n${usage}`)
  }
}

function parseCommand(arguments_: readonly string[]): ParsedCommand {
  const [command, ...optionArguments] = arguments_
  if (command !== 'issue' && command !== 'redeem') throw new Error(usage)
  const options = parseOptions(optionArguments)
  const ownerEmail = requiredOption(options, '--owner-email')
  const codeFile = requireAbsoluteFilePath(
    requiredOption(options, '--code-file'),
    '--code-file',
  )

  if (command === 'issue') {
    rejectUnknownOptions(
      options,
      new Set(['--owner-email', '--code-file', '--ttl-minutes']),
    )
    const ttlMinutes = Number(requiredOption(options, '--ttl-minutes'))
    return { kind: 'issue', ownerEmail, codeFile, ttlMinutes }
  }

  rejectUnknownOptions(
    options,
    new Set(['--owner-email', '--code-file', '--password-file']),
  )
  return {
    kind: 'redeem',
    ownerEmail,
    codeFile,
    passwordFile: requireAbsoluteFilePath(
      requiredOption(options, '--password-file'),
      '--password-file',
    ),
  }
}

async function issue(command: Extract<ParsedCommand, { kind: 'issue' }>): Promise<void> {
  const codeFile = await createOwnerSecretFile({
    path: command.codeFile,
    label: 'Recovery code file',
    maxBytes: recoveryCodeFileLimitBytes,
  })
  try {
    const issued = await issueOwnerRecoveryFromHostCli({
      ownerEmail: command.ownerEmail,
      ttlMinutes: command.ttlMinutes,
    })
    await codeFile.writeSecret(issued.code)
    console.log(
      `Recovery code written to ${command.codeFile}; it expires at ${issued.expiresAt.toISOString()}.`,
    )
  } catch (error) {
    try {
      await codeFile.discard()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Owner recovery issuance failed and its reserved output path changed before cleanup.',
      )
    }
    throw error
  } finally {
    await codeFile.close()
  }
}

async function redeem(
  command: Extract<ParsedCommand, { kind: 'redeem' }>,
): Promise<void> {
  const codeFile = await openOwnerSecretFile({
    path: command.codeFile,
    label: 'Recovery code file',
    maxBytes: recoveryCodeFileLimitBytes,
  })
  let passwordFile: Awaited<ReturnType<typeof openOwnerSecretFile>> | undefined
  try {
    passwordFile = await openOwnerSecretFile({
      path: command.passwordFile,
      label: 'Password file',
      maxBytes: passwordFileLimitBytes,
    })
    const [code, newPassword] = await Promise.all([
      codeFile.readSecret(),
      passwordFile.readSecret(),
    ])
    const redeemed = await redeemOwnerRecoveryFromHostCli({
      ownerEmail: command.ownerEmail,
      code,
      newPassword,
    })

    try {
      await codeFile.consume()
    } catch (error) {
      console.warn(
        `Owner credential recovered, but the recovery code path was not removed safely: ${error instanceof Error ? error.message : 'unknown cleanup error'}. The database code is already invalid; inspect the path manually.`,
      )
    }
    console.log(
      `Owner credential recovered; ${redeemed.revokedSessionCount} existing owner session(s) revoked.`,
    )
  } finally {
    await Promise.all([codeFile.close(), passwordFile?.close()])
  }
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2))
  if (command.kind === 'issue') await issue(command)
  else await redeem(command)
}

try {
  await main()
} catch (error) {
  if (error instanceof OwnerRecoveryError) {
    console.error(`Owner recovery failed (${error.code}): ${error.message}`)
  } else {
    console.error(
      `Owner recovery failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
  process.exitCode = 1
}
