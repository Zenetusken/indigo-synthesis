import { isAbsolute, resolve } from 'node:path'
import { issueOwnerBootstrapFromHostCli } from '@/composition/identity-bootstrap-mutations'
import { OwnerBootstrapError } from '@/modules/identity/bootstrap/owner-bootstrap'
import { createOwnerSecretFile } from '@/platform/security/owner-secret-file'

const codeFileMaxBytes = 256
const usage = `Usage:
  pnpm owner:bootstrap issue --code-file ABSOLUTE_PATH --ttl-minutes 15

The code is written only to a new owner-owned file in a protected directory and is never printed.`

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

function parseCommand(arguments_: readonly string[]) {
  const [command, ...optionArguments] = arguments_
  if (command !== 'issue') throw new Error(usage)
  const options = parseOptions(optionArguments)
  for (const name of options.keys()) {
    if (!new Set(['--code-file', '--ttl-minutes']).has(name)) {
      throw new Error(`Unknown option ${name}.\n\n${usage}`)
    }
  }

  const rawCodeFile = requiredOption(options, '--code-file')
  if (!isAbsolute(rawCodeFile)) throw new Error('--code-file must be an absolute path.')
  return {
    codeFile: resolve(rawCodeFile),
    ttlMinutes: Number(requiredOption(options, '--ttl-minutes')),
  }
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2))
  const file = await createOwnerSecretFile({
    path: command.codeFile,
    label: 'Owner bootstrap code file',
    maxBytes: codeFileMaxBytes,
  })

  try {
    const issued = await issueOwnerBootstrapFromHostCli({
      ttlMinutes: command.ttlMinutes,
    })
    await file.writeSecret(issued.code)
    process.stdout.write(
      `Owner bootstrap code written to ${command.codeFile}; it expires at ${issued.expiresAt.toISOString()}.\n`,
    )
  } catch (error) {
    try {
      await file.discard()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Owner bootstrap issuance failed and its reserved output path changed before cleanup.',
      )
    }
    throw error
  } finally {
    await file.close()
  }
}

try {
  await main()
} catch (error) {
  if (error instanceof OwnerBootstrapError) {
    process.stderr.write(`Owner bootstrap failed (${error.code}): ${error.message}\n`)
  } else {
    process.stderr.write(
      `Owner bootstrap failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`,
    )
  }
  process.exitCode = 1
}
