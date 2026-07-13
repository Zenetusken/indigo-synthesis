import { expect, type Page } from '@playwright/test'
import { Client } from 'pg'
import { issueOwnerBootstrap } from '@/modules/identity/bootstrap/owner-bootstrap'
import { resetServerConfigForTests } from '@/platform/config/server'
import { closeDb } from '@/platform/db/client'

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

export function bindE2eProcessEnv(): void {
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
  const client = await databaseClient()
  try {
    // Keep the live Next server up between tests without taking TRUNCATE's
    // schema-wide CASCADE lock set. Follow the production instance-reset order instead
    // of relying on nondeterministic user-FK cascade order: sessions must disappear
    // before programs because workout_session -> planned_workout is RESTRICT, and
    // immutable decision/lineage rows require the authorized reset mode.
    await client.query('BEGIN')
    await client.query("SET LOCAL indigo.deletion_mode = 'instance-reset'")
    await client.query('DELETE FROM installation_state')
    await client.query('DELETE FROM future_load_explanation_cache')
    await client.query('DELETE FROM training_command_receipt')
    await client.query('DELETE FROM program_revision_lineage')
    await client.query('DELETE FROM workout_session')
    await client.query('DELETE FROM program')
    await client.query('DELETE FROM adjustment_decision')
    await client.query('DELETE FROM performed_set')
    await client.query('DELETE FROM session_exercise')
    await client.query('DELETE FROM session_feedback')
    await client.query('DELETE FROM set_prescription')
    await client.query('DELETE FROM exercise_prescription')
    await client.query('DELETE FROM planned_workout')
    await client.query('DELETE FROM program_revision')
    await client.query('DELETE FROM safety_hold')
    await client.query('DELETE FROM strength_baseline')
    await client.query('DELETE FROM athlete_equipment')
    await client.query('DELETE FROM athlete_training_day')
    await client.query('DELETE FROM athlete_profile')
    await client.query('DELETE FROM audit_event')
    await client.query('DELETE FROM deletion_plan')
    await client.query('DELETE FROM verification')
    await client.query('DELETE FROM session')
    await client.query('DELETE FROM account')
    await client.query('DELETE FROM "user"')
    await client.query('DELETE FROM deletion_tombstone')
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
  while (remaining > 0) {
    const button = page.getByRole('button', { name: 'Complete set' }).first()
    const form = button.locator('xpath=ancestor::form')
    await form.getByLabel('RPE (optional)').fill(rpe)
    await button.click()
    await expect(page.getByText(/Draft saved in PostgreSQL/)).toBeVisible()
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
