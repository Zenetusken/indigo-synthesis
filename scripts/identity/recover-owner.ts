import { lstat, open, readFile, unlink } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import {
  issueOwnerRecovery,
  OwnerRecoveryError,
  redeemOwnerRecovery,
} from '@/modules/identity/recovery/owner-recovery'
import { closeDb } from '@/platform/db/client'

const usage = `Usage:
  pnpm owner:recover issue --owner-email EMAIL --code-file ABSOLUTE_PATH --ttl-minutes 15
  pnpm owner:recover redeem --owner-email EMAIL --code-file ABSOLUTE_PATH --password-file ABSOLUTE_PATH

Secrets are accepted only through owner-readable files, never command arguments.`

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

function stripOneTerminalLineBreak(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2)
  if (value.endsWith('\n')) return value.slice(0, -1)
  return value
}

async function readOwnerOnlySecret(path: string, label: string): Promise<string> {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a link.`)
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be readable or writable by group or other users.`)
  }

  const value = stripOneTerminalLineBreak(await readFile(path, 'utf8'))
  if (!value || value.includes('\n') || value.includes('\r')) {
    throw new Error(`${label} must contain exactly one non-empty line.`)
  }
  return value
}

async function issue(command: Extract<ParsedCommand, { kind: 'issue' }>): Promise<void> {
  const codeFile = await open(command.codeFile, 'wx', 0o600)
  try {
    const issued = await issueOwnerRecovery({
      ownerEmail: command.ownerEmail,
      ttlMinutes: command.ttlMinutes,
    })
    await codeFile.writeFile(`${issued.code}\n`, 'utf8')
    await codeFile.sync()
    console.log(
      `Recovery code written to ${command.codeFile}; it expires at ${issued.expiresAt.toISOString()}.`,
    )
  } catch (error) {
    await codeFile.close()
    await unlink(command.codeFile).catch(() => undefined)
    throw error
  }
  await codeFile.close()
}

async function redeem(
  command: Extract<ParsedCommand, { kind: 'redeem' }>,
): Promise<void> {
  const code = await readOwnerOnlySecret(command.codeFile, 'Recovery code file')
  const newPassword = await readOwnerOnlySecret(command.passwordFile, 'Password file')
  const redeemed = await redeemOwnerRecovery({
    ownerEmail: command.ownerEmail,
    code,
    newPassword,
  })
  await unlink(command.codeFile)
  console.log(
    `Owner credential recovered; ${redeemed.revokedSessionCount} existing owner session(s) revoked.`,
  )
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
} finally {
  await closeDb()
}
