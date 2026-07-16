import { cleanupExpiredSessionsFromHostCli } from '@/composition/identity-session-maintenance'
import { ExpiredSessionMaintenanceError } from '@/modules/identity/application/expired-session-maintenance'

const usage = `Usage:
  pnpm identity:cleanup-expired-sessions --batch-size 64 [--cursor CURSOR]

The cursor is opaque operational state. Quote it exactly and keep it out of logs.`

const inheritedHostLockError =
  'This host command must be launched through scripts/run-external-host-command.sh.'

class CommandInputError extends Error {
  constructor() {
    super(`Invalid expired-session maintenance arguments.\n\n${usage}`)
    this.name = 'CommandInputError'
  }
}

type ParsedCommand = Readonly<{
  batchSize: number
  cursor?: string
}>

function parseCommand(arguments_: readonly string[]): ParsedCommand {
  let batchSize: number | undefined
  let cursor: string | undefined
  let sawBatchSize = false
  let sawCursor = false

  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index]
    const value = arguments_[index + 1]
    if (!option || value === undefined || value.length === 0 || value.startsWith('--')) {
      throw new CommandInputError()
    }

    if (option === '--batch-size' && !sawBatchSize) {
      sawBatchSize = true
      if (!/^(?:[1-9]|[1-5][0-9]|6[0-4])$/.test(value)) {
        throw new CommandInputError()
      }
      batchSize = Number(value)
      continue
    }

    if (option === '--cursor' && !sawCursor) {
      sawCursor = true
      cursor = value
      continue
    }

    throw new CommandInputError()
  }

  if (batchSize === undefined) throw new CommandInputError()
  return cursor === undefined ? { batchSize } : { batchSize, cursor }
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2))
  const result = await cleanupExpiredSessionsFromHostCli(command)
  const output =
    result.status === 'continue'
      ? {
          status: result.status,
          deletedCount: result.deletedCount,
          nextCursor: result.nextCursor,
        }
      : {
          status: result.status,
          deletedCount: result.deletedCount,
          nextCursor: null,
        }
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

try {
  await main()
} catch (error) {
  if (error instanceof CommandInputError) {
    process.stderr.write(`${error.message}\n`)
  } else if (error instanceof ExpiredSessionMaintenanceError) {
    process.stderr.write(
      `Expired-session maintenance failed (${error.code}): ${error.message}\n`,
    )
  } else if (error instanceof Error && error.message === inheritedHostLockError) {
    process.stderr.write(
      `Expired-session maintenance failed: ${inheritedHostLockError}\n`,
    )
  } else {
    process.stderr.write('Expired-session maintenance failed.\n')
  }
  process.exitCode = 1
}
