import { expect, type Page } from '@playwright/test'
import { Client } from 'pg'
import { issueOwnerBootstrap } from '@/modules/identity/bootstrap/owner-bootstrap'
import { resetServerConfigForTests } from '@/platform/config/server'
import { closeDb } from '@/platform/db/client'
import { validateLocalE2eResetTarget } from '@/platform/db/e2e-reset-guard'
import { e2eApplicationDataResetTableOrder } from './application-data-reset'
import { e2eAdministrationUrlEnvironment } from './reset-target'

// Test modules rebind DATABASE_URL to the disposable target for server-side helpers.
// Capture the administration URL first so the destructive primitive can revalidate the
// original admin/target pair immediately before connecting.
const e2eAdministrationUrl =
  process.env[e2eAdministrationUrlEnvironment] ?? process.env.DATABASE_URL

/**
 * Shared J1–J4 helpers for Playwright journeys.
 * Callers must set DATABASE_URL / BETTER_AUTH_SECRET from E2E_* before importing
 * server modules (see mvp.spec.ts / llm-live.spec.ts).
 */
export const e2eOwner = {
  name: 'E2E Owner',
  email: 'owner@example.test',
  password: 'correct-horse-battery-staple',
} as const

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth
    return Array.from(document.body.querySelectorAll<HTMLElement>('*'))
      .map((element) => {
        const bounds = element.getBoundingClientRect()
        return {
          element: `${element.tagName.toLowerCase()}.${element.className}`,
          left: Math.round(bounds.left),
          right: Math.round(bounds.right),
        }
      })
      .filter(({ left, right }) => left < -1 || right > viewportWidth + 1)
      .slice(0, 10)
  })
  expect(overflow, 'elements extending beyond the document viewport').toEqual([])
}

export function bindE2eProcessEnv(): void {
  validateLocalE2eResetTarget(e2eAdministrationUrl, process.env.E2E_DATABASE_URL)
  process.env.DATABASE_URL = process.env.E2E_DATABASE_URL
  process.env.BETTER_AUTH_SECRET = process.env.E2E_BETTER_AUTH_SECRET
  resetServerConfigForTests()
}

export async function databaseClient(): Promise<Client> {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('E2E_DATABASE_URL is required.')
  const client = new Client({ connectionString })
  await client.connect()
  return client
}

export async function clearApplicationData(): Promise<void> {
  validateLocalE2eResetTarget(e2eAdministrationUrl, process.env.E2E_DATABASE_URL)
  const client = await databaseClient()
  try {
    // Keep the live Next server up between tests without taking TRUNCATE's
    // schema-wide CASCADE lock set. Follow the production instance-reset order instead
    // of relying on nondeterministic user-FK cascade order: sessions must disappear
    // before programs because workout_session -> planned_workout is RESTRICT, and
    // immutable decision/lineage rows require the authorized reset mode.
    await client.query('BEGIN')
    await client.query("SET LOCAL indigo.deletion_mode = 'instance-reset'")
    for (const tableName of e2eApplicationDataResetTableOrder) {
      // The names come exclusively from the checked-in reset manifest. Quote each
      // identifier so reserved names such as "user" stay unambiguous.
      await client.query(`DELETE FROM "${tableName}"`)
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

export async function bootstrapAndSignIn(page: Page): Promise<void> {
  const issued = await issueOwnerBootstrap({ ttlMinutes: 15 })
  await closeDb()

  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: 'Initialize this instance.' }),
  ).toBeVisible()
  await page.getByLabel('Host-issued bootstrap code').fill(issued.code)
  await page.getByLabel('Name').fill(e2eOwner.name)
  await page.getByLabel('Local sign-in email').fill(e2eOwner.email)
  await page.locator('input[name="password"]').fill(e2eOwner.password)
  await page.getByLabel('Confirm password').fill(e2eOwner.password)
  await page.getByRole('button', { name: 'Create owner account' }).click()

  await expect(page).toHaveURL(/\/sign-in\?created=1/)
  await page.getByLabel('Email').fill(e2eOwner.email)
  await page.getByLabel('Password').fill(e2eOwner.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/setup$/)
}

export async function completeSetup(
  page: Page,
  restriction: 'none' | 'present' | 'uncertain' = 'none',
  units: 'metric' | 'imperial' = 'metric',
): Promise<void> {
  await page.getByLabel('Display units').selectOption(units)
  await page.getByLabel('IANA timezone').fill('UTC')
  await page.getByLabel('I confirm that I am at least 18 years old.').check()
  await page
    .getByLabel(
      'I confirm that I already know how to perform the listed exercises safely.',
    )
    .check()

  const weekdayInputs = page.locator('input[name="weekdays"]')
  for (let index = 0; index < (await weekdayInputs.count()); index += 1) {
    const input = weekdayInputs.nth(index)
    if (await input.isChecked()) await input.uncheck()
  }
  const currentDay = new Date().getUTCDay()
  const chosenDays = [currentDay, (currentDay + 2) % 7, (currentDay + 4) % 7]
  for (const day of chosenDays) {
    await page.locator(`input[name="weekdays"][value="${day}"]`).check()
  }

  await page
    .getByLabel(
      restriction === 'none'
        ? 'No current restriction or uncertainty'
        : restriction === 'present'
          ? 'Yes, I have a current restriction'
          : 'I am uncertain',
    )
    .check()
  if (restriction !== 'none') {
    await page
      .getByLabel('Trainee-reported context (required for “yes” or “uncertain”)')
      .fill('User-reported test restriction')
  }

  const startingLoads = page.locator('input[name^="load-"]')
  for (let index = 0; index < (await startingLoads.count()); index += 1) {
    await startingLoads.nth(index).fill('60')
  }

  await page.getByRole('button', { name: 'Save setup and review program' }).click()
  await expect(page).toHaveURL(/\/program$/)
}

export async function generateAndActivate(page: Page): Promise<void> {
  await page.getByLabel('Program start date').fill(todayIso())
  await page.getByRole('button', { name: 'Create development program' }).click()
  await expect(
    page.getByRole('heading', { name: 'Two-cycle A/B/C fixture' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Activate development program' }).click()
  await expect(page).toHaveURL(/\/today$/)
  await expect(
    page.getByRole('heading', { name: /Session [ABC] is scheduled/ }),
  ).toBeVisible()
}

/** Complete every open set at target load with the given RPE (default 8 → increase). */
export async function completeAllSetsAtTarget(page: Page, rpe = '8'): Promise<void> {
  let remaining = await page.getByRole('button', { name: 'Complete set' }).count()
  expect(remaining).toBeGreaterThan(0)
  const draftStatus = page
    .getByRole('status')
    .filter({ hasText: 'Draft saved · revision' })
  await expect(draftStatus).toBeVisible()
  while (remaining > 0) {
    const previousDraftStatus = await draftStatus.textContent()
    expect(previousDraftStatus).not.toBeNull()
    const button = page.getByRole('button', { name: 'Complete set' }).first()
    const form = button.locator('xpath=ancestor::form')
    await form.getByLabel('RPE (optional)').fill(rpe)
    await button.click()
    await expect(draftStatus).not.toHaveText(previousDraftStatus ?? '')
    await expect(page.getByRole('button', { name: 'Complete set' })).toHaveCount(
      remaining - 1,
    )
    remaining -= 1
  }
}

export async function completeWorkoutToHistory(page: Page): Promise<void> {
  await page
    .getByLabel(
      'I confirm that I am not reporting pain or a safety issue from this session.',
    )
    .check()
  await page.getByRole('button', { name: 'Complete workout' }).click()
  await expect(page).toHaveURL(/\/history\//)
  await expect(page.getByRole('heading', { name: 'Workout completed.' })).toBeVisible()
}
