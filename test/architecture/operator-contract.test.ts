import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getTableName, isTable } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import * as databaseSchema from '@/platform/db/schema'
import nextConfig from '../../next.config'
import { e2eApplicationDataResetTableOrder } from '../e2e/support/application-data-reset'
import {
  defaultE2eSuiteSelection,
  liveLlmE2eSuiteSelection,
} from '../e2e/support/suite-selection'

const projectRoot = process.cwd()

describe('clean-clone operator contract', () => {
  it('never serializes server-action credentials into development logs', () => {
    expect(nextConfig.logging).toMatchObject({ serverFunctions: false })
  })

  it('pins integration tests to the test runtime and development fixture', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(projectRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> }
    const integration = manifest.scripts?.['test:integration'] ?? ''

    expect(integration).toContain('NODE_ENV=test')
    expect(integration).toContain('INDIGO_CONTENT_MODE=development')
  })

  it('provides a safe, copyable E2E environment template', () => {
    const examplePath = resolve(projectRoot, '.env.e2e.example')
    expect(existsSync(examplePath)).toBe(true)

    const example = readFileSync(examplePath, 'utf8')
    expect(example).toContain('E2E_DATABASE_URL=postgresql://')
    expect(example).toContain('/indigo_synthesis_e2e')
    expect(example).toContain('E2E_BETTER_AUTH_SECRET=')
    expect(example).not.toMatch(/^DATABASE_URL=/m)
    expect(example).not.toMatch(/^BETTER_AUTH_SECRET=/m)
  })

  it('documents browser installation and disposable database preparation', () => {
    const readme = readFileSync(resolve(projectRoot, 'README.md'), 'utf8')

    expect(readme).toContain('pnpm install --frozen-lockfile')
    expect(readme).toContain('pnpm exec playwright install chromium')
    expect(readme).toContain('cp .env.e2e.example .env.e2e.local')
    expect(readme).toContain('drops and recreates')
  })

  it('keeps migration SQL byte-stable with a canonical LF checkout policy', () => {
    const attributes = readFileSync(resolve(projectRoot, '.gitattributes'), 'utf8')
    expect(attributes).toMatch(/^drizzle\/\*\.sql text eol=lf$/m)

    const migration = readFileSync(
      resolve(projectRoot, 'drizzle/0004_magenta_the_spike.sql'),
    )
    expect(migration.includes(13)).toBe(false)
    expect(createHash('sha256').update(migration).digest('hex')).toBe(
      'e5d7105d56a02ba8874fef8f2a724981363e74f809b22d909a0e7cec75564ba0',
    )
  })

  it('keeps live GPU LLM Playwright opt-in and separate from default e2e', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(projectRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> }
    const defaultE2e = manifest.scripts?.['test:e2e'] ?? ''
    const llmE2e = manifest.scripts?.['test:e2e:llm'] ?? ''

    expect(defaultE2e).toContain('scripts/e2e/run.sh default')
    expect(llmE2e).toContain('scripts/e2e/run.sh llm')
    const e2eRunner = readFileSync(resolve(projectRoot, 'scripts/e2e/run.sh'), 'utf8')
    expect(e2eRunner).toContain('@playwright/test/cli.js')
    expect(e2eRunner).toContain('playwright.llm.config.ts')

    expect(defaultE2eSuiteSelection).toEqual({
      testMatch: '**/*.spec.ts',
      testIgnore: ['**/llm-live.spec.ts'],
    })
    expect(liveLlmE2eSuiteSelection).toEqual({
      testMatch: '**/llm-live.spec.ts',
    })

    for (const configName of ['playwright.config.ts', 'playwright.llm.config.ts']) {
      const config = readFileSync(resolve(projectRoot, configName), 'utf8')
      expect(config).toContain('pinE2eAdministrationUrl')
    }
    const resetTarget = readFileSync(
      resolve(projectRoot, 'test/e2e/support/reset-target.ts'),
      'utf8',
    )
    expect(resetTarget).toContain('validateLocalE2eResetTarget')
    expect(resetTarget).toContain('INDIGO_E2E_ADMINISTRATION_DATABASE_URL')
    const journey = readFileSync(
      resolve(projectRoot, 'test/e2e/support/journey.ts'),
      'utf8',
    )
    expect(journey).toMatch(
      /clearApplicationData[\s\S]*validateLocalE2eResetTarget[\s\S]*databaseClient/,
    )

    const playwrightCli = resolve(projectRoot, 'node_modules/@playwright/test/cli.js')
    const safeEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: 'postgresql://indigo:local@127.0.0.1:55432/postgres',
      E2E_DATABASE_URL: 'postgresql://indigo:local@127.0.0.1:55432/indigo_contract_e2e',
      E2E_BETTER_AUTH_SECRET: 'contract-only-secret',
    }
    delete safeEnvironment.INDIGO_E2E_ADMINISTRATION_DATABASE_URL

    const defaultList = execFileSync(
      process.execPath,
      [playwrightCli, 'test', '--list'],
      { cwd: projectRoot, encoding: 'utf8', env: safeEnvironment },
    )
    const defaultTests = defaultList
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /\.spec\.ts:\d+:\d+\s+›/.test(line))
    expect(defaultTests.length).toBeGreaterThan(0)
    expect(defaultTests.every((line) => !line.includes('llm-live.spec.ts'))).toBe(true)

    const liveList = execFileSync(
      process.execPath,
      [playwrightCli, 'test', '--list', '-c', 'playwright.llm.config.ts'],
      { cwd: projectRoot, encoding: 'utf8', env: safeEnvironment },
    )
    const liveTests = liveList
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /\.spec\.ts:\d+:\d+\s+›/.test(line))
    expect(liveTests.length).toBeGreaterThan(0)
    expect(liveTests.every((line) => line.includes('llm-live.spec.ts'))).toBe(true)

    for (const configName of [undefined, 'playwright.llm.config.ts']) {
      const configArguments = configName ? ['-c', configName] : []
      const unsafeList = spawnSync(
        process.execPath,
        [playwrightCli, 'test', '--list', ...configArguments],
        {
          cwd: projectRoot,
          encoding: 'utf8',
          env: {
            ...safeEnvironment,
            E2E_DATABASE_URL: 'postgresql://indigo:local@127.0.0.1:55432/valuable',
          },
        },
      )
      expect(unsafeList.status).not.toBe(0)
      expect(`${unsafeList.stdout}${unsafeList.stderr}`).toContain(
        'E2E_DATABASE_URL database must match indigo_<name>_e2e',
      )
    }
  }, 15_000)

  it('keeps every application table in the production-aligned E2E clear order', () => {
    const schemaTables = Object.values(databaseSchema)
      .filter(isTable)
      .map((table) => getTableName(table))
      .sort()
    const e2eTables = [...e2eApplicationDataResetTableOrder]

    expect(new Set(e2eTables).size).toBe(e2eTables.length)
    expect([...e2eTables].sort()).toEqual(schemaTables)

    const destructiveAdapterSource = readFileSync(
      resolve(
        projectRoot,
        'src/modules/data-portability/infrastructure/scoped-destructive-adapter.ts',
      ),
      'utf8',
    )
    const instanceResetStart = destructiveAdapterSource.indexOf(
      'async function executeInstanceReset',
    )
    expect(instanceResetStart).toBeGreaterThan(-1)
    const instanceResetEnd = destructiveAdapterSource.indexOf(
      'export function createScopedSubjectDeletionAttemptGateway',
      instanceResetStart,
    )
    expect(instanceResetEnd).toBeGreaterThan(instanceResetStart)
    const productionTableExports = [
      ...destructiveAdapterSource
        .slice(instanceResetStart, instanceResetEnd)
        .matchAll(/await database\.delete\((\w+)\)/g),
    ].map((match) => match[1])
    const tableNameByExport = new Map<string, string>()
    for (const [exportName, table] of Object.entries(databaseSchema)) {
      if (isTable(table)) tableNameByExport.set(exportName, getTableName(table))
    }
    const productionTables = productionTableExports.map((exportName) => {
      const tableName = tableNameByExport.get(exportName)
      if (!tableName) {
        throw new Error(`Unknown schema table export in instance reset: ${exportName}`)
      }
      return tableName
    })

    // Production preserves the singleton and prior non-identifying tombstones; E2E
    // deliberately removes both to provide a clean owner-bootstrap fixture.
    expect(e2eTables).toEqual([
      'installation_state',
      ...productionTables,
      'deletion_tombstone',
    ])
    const e2eResetSource = readFileSync(
      resolve(projectRoot, 'test/e2e/support/journey.ts'),
      'utf8',
    )
    expect(e2eResetSource).toContain(
      `INSERT INTO "installation_state" ("singleton") VALUES (1)`,
    )

    const restartReplay = readFileSync(
      resolve(projectRoot, 'test/e2e/restart-replay.spec.ts'),
      'utf8',
    )
    expect(restartReplay).not.toContain('TRUNCATE TABLE')
    expect(restartReplay).toMatch(
      /import\s*{[^}]*\bclearApplicationData\b[^}]*}\s*from\s*['"]\.\/support\/journey['"]/,
    )
  })

  it('scrubs dynamic-loader injection from the supported LLM launcher', () => {
    const launcher = readFileSync(
      resolve(projectRoot, 'scripts/llm/serve-local.sh'),
      'utf8',
    )
    expect(launcher).toContain('unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT')
    expect(launcher).toContain('WEIGHTS="$ROOT/llm/weights/qwen3.5-9b-q4_k_m.gguf"')
    expect(launcher).not.toContain('WEIGHTS="${INDIGO_LLM_WEIGHTS:-')
    expect(launcher).toContain('CTX=4096')
    expect(launcher).toContain('requires INDIGO_LLM_CTX=$CTX')
  })

  it('pins calibrated product measurements to the committed settings contract', () => {
    const archive = readFileSync(
      resolve(projectRoot, 'scripts/llm/archive-product-path.sh'),
      'utf8',
    )
    expect(archive).toContain('export INDIGO_LLM_TIMEOUT_MS=3000')
    expect(archive).toContain('export INDIGO_LLM_MODELS_DIR="$ROOT/llm/models"')

    const liveConfig = readFileSync(
      resolve(projectRoot, 'playwright.llm.config.ts'),
      'utf8',
    )
    expect(liveConfig).toContain("INDIGO_LLM_TIMEOUT_MS: '3000'")
    expect(liveConfig).toContain("INDIGO_LLM_MODELS_DIR: 'llm/models'")
  })

  it('pins the complete production external-host command census', async () => {
    const manifest = JSON.parse(
      readFileSync(resolve(projectRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> }
    const commandNames = [
      'owner:bootstrap',
      'owner:recover',
      'identity:cleanup-expired-sessions',
      'db:migrate',
      'db:preflight',
      'start',
    ] as const
    const externalHostCommands = Object.fromEntries(
      commandNames.map((name) => [name, manifest.scripts?.[name]]),
    )
    expect(externalHostCommands).toEqual({
      'owner:bootstrap':
        'bash scripts/run-external-host-command.sh scripts/identity/bootstrap-owner.ts',
      'owner:recover':
        'bash scripts/run-external-host-command.sh scripts/identity/recover-owner.ts',
      'identity:cleanup-expired-sessions':
        'bash scripts/run-external-host-command.sh scripts/identity/cleanup-expired-sessions.ts',
      'db:migrate': 'bash scripts/run-external-host-command.sh scripts/db/migrate.ts',
      'db:preflight': 'bash scripts/run-external-host-command.sh scripts/db/preflight.ts',
      start:
        'NODE_ENV=production pnpm db:preflight && NEXT_TELEMETRY_DISABLED=1 next start --hostname 127.0.0.1',
    })

    const wrapperConsumers = Object.entries(manifest.scripts ?? {})
      .filter(([, command]) => command.includes('scripts/run-external-host-command.sh'))
      .map(([name]) => name)
      .sort()
    expect(wrapperConsumers).toEqual([
      'db:migrate',
      'db:preflight',
      'identity:cleanup-expired-sessions',
      'owner:bootstrap',
      'owner:recover',
    ])

    const productionDatabaseEntrypointConsumers = Object.entries(manifest.scripts ?? {})
      .filter(
        ([name, command]) =>
          name !== 'db:backup-restore-drill' &&
          /scripts\/(?:db|identity)\/[^ ]+\.ts(?: |$)/.test(command),
      )
      .map(([name]) => name)
      .sort()
    expect(productionDatabaseEntrypointConsumers).toEqual(wrapperConsumers)

    const maintenanceEntrypoint = resolve(
      projectRoot,
      'scripts/identity/cleanup-expired-sessions.ts',
    )
    const directEnvironment = { ...process.env }
    delete directEnvironment.INDIGO_EXTERNAL_HOST_LOCK_HELD
    delete directEnvironment.INDIGO_EXTERNAL_HOST_LOCK_FD
    delete directEnvironment.INDIGO_EXTERNAL_HOST_LOCK_PATH

    const sensitiveCursor = 'do-not-reflect-this-cursor'
    const invalidMaintenance = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        maintenanceEntrypoint,
        '--batch-size',
        '65',
        '--cursor',
        sensitiveCursor,
      ],
      { cwd: projectRoot, encoding: 'utf8', env: directEnvironment },
    )
    expect(invalidMaintenance.status).toBe(1)
    expect(invalidMaintenance.stdout).toBe('')
    expect(invalidMaintenance.stderr).toContain(
      'Invalid expired-session maintenance arguments.',
    )
    expect(invalidMaintenance.stderr).not.toContain(sensitiveCursor)

    const directMaintenance = spawnSync(
      process.execPath,
      ['--import', 'tsx', maintenanceEntrypoint, '--batch-size', '1'],
      { cwd: projectRoot, encoding: 'utf8', env: directEnvironment },
    )
    expect(directMaintenance.status).toBe(1)
    expect(directMaintenance.stdout).toBe('')
    expect(directMaintenance.stderr).toContain('run-external-host-command.sh')

    const directory = mkdtempSync(join(tmpdir(), 'indigo-external-host-lock-'))
    const firstMarker = join(directory, 'first-entrypoint-ran')
    const secondMarker = join(directory, 'second-entrypoint-ran')
    const wrapper = resolve(projectRoot, 'scripts/run-external-host-command.sh')
    const fixture = resolve(
      projectRoot,
      'test/architecture/fixtures/external-host-lock-entrypoint.ts',
    )
    const first = spawn('bash', [wrapper, fixture, firstMarker, 'hold'], {
      cwd: projectRoot,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let firstStderr = ''
    first.stderr.setEncoding('utf8')
    first.stderr.on('data', (chunk: string) => {
      firstStderr += chunk
    })

    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        let stdout = ''
        const timeout = setTimeout(() => {
          rejectReady(
            new Error(`Timed out waiting for the first host wrapper: ${firstStderr}`),
          )
        }, 5_000)
        const settle = (operation: () => void): void => {
          clearTimeout(timeout)
          first.stdout.removeAllListeners('data')
          first.removeAllListeners('exit')
          operation()
        }
        first.stdout.setEncoding('utf8')
        first.stdout.on('data', (chunk: string) => {
          stdout += chunk
          if (stdout.includes('READY\n')) settle(resolveReady)
        })
        first.once('exit', (code, signal) => {
          settle(() => {
            rejectReady(
              new Error(
                `First host wrapper exited before readiness (code=${code}, signal=${signal}): ${firstStderr}`,
              ),
            )
          })
        })
      })

      expect(existsSync(firstMarker)).toBe(true)
      const second = spawnSync('bash', [wrapper, fixture, secondMarker, 'exit'], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: process.env,
      })
      expect(second.status).toBe(75)
      expect(`${second.stdout}${second.stderr}`).toContain(
        'another Indigo host database command is active',
      )
      expect(existsSync(secondMarker)).toBe(false)
    } finally {
      if (first.exitCode === null && first.signalCode === null) {
        const exit = new Promise<void>((resolveExit) => {
          const timeout = setTimeout(() => {
            first.kill('SIGKILL')
          }, 5_000)
          first.once('exit', () => {
            clearTimeout(timeout)
            resolveExit()
          })
        })
        first.stdin.end('\n')
        await exit
      }
      rmSync(directory, { force: true, recursive: true })
    }
  }, 15_000)
})
