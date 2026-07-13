import { randomBytes } from 'node:crypto'
import { defineConfig, devices } from '@playwright/test'
import {
  e2eApplicationUrl,
  e2eNextDistDir,
  e2eSupervisorTokenEnvironment,
} from './test/e2e/support/supervisor-contract'

const baseURL = e2eApplicationUrl
const databaseUrl = process.env.E2E_DATABASE_URL
const authSecret = process.env.E2E_BETTER_AUTH_SECRET
const supervisorToken =
  process.env[e2eSupervisorTokenEnvironment] ?? randomBytes(32).toString('hex')

process.env[e2eSupervisorTokenEnvironment] = supervisorToken

if (!databaseUrl || !authSecret) {
  throw new Error('E2E_DATABASE_URL and E2E_BETTER_AUTH_SECRET are required.')
}

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.spec.ts',
  // Live GPU/LLM suite is opt-in via playwright.llm.config.ts (`pnpm test:e2e:llm`).
  testIgnore: ['**/llm-live.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node --import tsx test/e2e/support/next-supervisor.ts',
    name: 'Indigo E2E supervisor',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    stdout: 'pipe',
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: authSecret,
      BETTER_AUTH_URL: baseURL,
      E2E_SUPERVISOR_TOKEN: supervisorToken,
      INDIGO_NEXT_DIST_DIR: e2eNextDistDir,
      INDIGO_CONTENT_MODE: 'development',
      NEXT_TELEMETRY_DISABLED: '1',
      // Default product path: LLM stays off so CI/default e2e never needs a GPU.
      INDIGO_LLM_MODE: process.env.INDIGO_LLM_MODE ?? 'disabled',
    },
  },
})
