import { randomBytes } from 'node:crypto'
import { defineConfig, devices } from '@playwright/test'
import {
  e2eApplicationUrl,
  e2eNextDistDir,
  e2eSupervisorTokenEnvironment,
} from './test/e2e/support/supervisor-contract'

/**
 * Opt-in Playwright config for live GPU / local LLM product path.
 * Does not run under default `pnpm test:e2e`. Use `pnpm test:e2e:llm`.
 *
 * Prerequisites:
 *   - Healthy NVIDIA GPU (`pnpm llm:preflight` → gpu.state=ready)
 *   - Loopback OpenAI-compatible server with pack model (e.g. `pnpm llm:serve`)
 *   - `.env.e2e.local` with E2E_DATABASE_URL + E2E_BETTER_AUTH_SECRET
 */
const baseURL = e2eApplicationUrl
const databaseUrl = process.env.E2E_DATABASE_URL
const authSecret = process.env.E2E_BETTER_AUTH_SECRET
const supervisorToken =
  process.env[e2eSupervisorTokenEnvironment] ?? randomBytes(32).toString('hex')

process.env[e2eSupervisorTokenEnvironment] = supervisorToken

if (!databaseUrl || !authSecret) {
  throw new Error('E2E_DATABASE_URL and E2E_BETTER_AUTH_SECRET are required.')
}

const llmModelId = process.env.INDIGO_LLM_MODEL_ID ?? 'qwen3.5-9b-q4_k_m'
const llmEndpoint = process.env.INDIGO_LLM_ENDPOINT ?? 'http://127.0.0.1:8080/v1'
const llmTimeoutMs = process.env.INDIGO_LLM_TIMEOUT_MS ?? '60000'
const llmSha256 =
  process.env.INDIGO_LLM_MODEL_SHA256 ??
  '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8'

const llmServerEnv = {
  INDIGO_LLM_MODE: 'local',
  INDIGO_LLM_MODEL_ID: llmModelId,
  INDIGO_LLM_ENDPOINT: llmEndpoint,
  INDIGO_LLM_TIMEOUT_MS: llmTimeoutMs,
  INDIGO_LLM_REQUIRE_GPU: process.env.INDIGO_LLM_REQUIRE_GPU ?? 'true',
  INDIGO_LLM_MODEL_SHA256: llmSha256,
  INDIGO_LLM_MODELS_DIR: process.env.INDIGO_LLM_MODELS_DIR ?? 'llm/models',
  INDIGO_LLM_WEIGHTS_DIR: process.env.INDIGO_LLM_WEIGHTS_DIR ?? 'llm/weights',
} as const

// Expose the same env to the test process for preflight assertions.
Object.assign(process.env, llmServerEnv)

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/llm-live.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Journey + cold Next compile + first GPU completion can exceed the default 60s.
  timeout: 240_000,
  expect: { timeout: 90_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node --import tsx test/e2e/support/next-supervisor.ts',
    name: 'Indigo E2E LLM supervisor',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    stdout: 'pipe',
    env: {
      ...process.env,
      ...llmServerEnv,
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: authSecret,
      BETTER_AUTH_URL: baseURL,
      E2E_SUPERVISOR_TOKEN: supervisorToken,
      INDIGO_NEXT_DIST_DIR: e2eNextDistDir,
      INDIGO_CONTENT_MODE: 'development',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
})
