import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:3100'
const databaseUrl = process.env.E2E_DATABASE_URL
const authSecret = process.env.E2E_BETTER_AUTH_SECRET

if (!databaseUrl || !authSecret) {
  throw new Error('E2E_DATABASE_URL and E2E_BETTER_AUTH_SECRET are required.')
}

export default defineConfig({
  testDir: './test/e2e',
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
    command: 'pnpm dev:e2e',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: authSecret,
      BETTER_AUTH_URL: baseURL,
      INDIGO_CONTENT_MODE: 'development',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
})
