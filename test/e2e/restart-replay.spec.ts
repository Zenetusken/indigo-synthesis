import { expect, type Page, type Request, test } from '@playwright/test'
import { Client } from 'pg'
import { issueOwnerBootstrap } from '@/modules/identity/bootstrap/owner-bootstrap'
import { resetServerConfigForTests } from '@/platform/config/server'
import { closeDb } from '@/platform/db/client'
import { restartE2eApplication } from './support/supervisor-client'

process.env.DATABASE_URL = process.env.E2E_DATABASE_URL
process.env.BETTER_AUTH_SECRET = process.env.E2E_BETTER_AUTH_SECRET
resetServerConfigForTests()

const owner = {
  name: 'Restart Replay Owner',
  email: 'restart-replay-owner@example.test',
  password: 'restart-replay-owner-password',
}

type CapturedServerAction = {
  readonly body: Buffer
  readonly headers: Record<string, string>
  readonly url: string
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

async function databaseClient(): Promise<Client> {
  const connectionString = process.env.E2E_DATABASE_URL
  if (!connectionString) throw new Error('E2E_DATABASE_URL is required.')
  const client = new Client({ connectionString })
  await client.connect()
  return client
}

async function clearApplicationData(): Promise<void> {
  const client = await databaseClient()
  try {
    await client.query(
      'TRUNCATE TABLE deletion_tombstone, installation_state, "user" CASCADE',
    )
  } finally {
    await client.end()
  }
}

async function bootstrapAndSignIn(page: Page): Promise<void> {
  const issued = await issueOwnerBootstrap({ ttlMinutes: 15 })
  await closeDb()

  await page.goto('/')
  await page.getByLabel('Host-issued bootstrap code').fill(issued.code)
  await page.getByLabel('Name').fill(owner.name)
  await page.getByLabel('Local sign-in email').fill(owner.email)
  await page.locator('input[name="password"]').fill(owner.password)
  await page.getByLabel('Confirm password').fill(owner.password)
  await page.getByRole('button', { name: 'Create owner account' }).click()

  await expect(page).toHaveURL(/\/sign-in\?created=1/)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/setup$/)
}

async function completeSetupAndStartWorkout(page: Page): Promise<void> {
  await page.getByLabel('Display units').selectOption('metric')
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
  for (const day of [currentDay, (currentDay + 2) % 7, (currentDay + 4) % 7]) {
    await page.locator(`input[name="weekdays"][value="${day}"]`).check()
  }

  await page.getByLabel('No current restriction or uncertainty').check()
  const startingLoads = page.locator('input[name^="load-"]')
  for (let index = 0; index < (await startingLoads.count()); index += 1) {
    await startingLoads.nth(index).fill('60')
  }
  await page.getByRole('button', { name: 'Save setup and review program' }).click()
  await expect(page).toHaveURL(/\/program$/)

  await page.getByLabel('Program start date').fill(todayIso())
  await page.getByRole('button', { name: 'Create development program' }).click()
  await page.getByRole('button', { name: 'Activate development program' }).click()
  await expect(page).toHaveURL(/\/today$/)
  await page.getByRole('button', { name: 'Start workout' }).click()
  await expect(page).toHaveURL(/\/workouts\//)
}

async function captureServerAction(
  page: Page,
  submit: () => Promise<unknown>,
): Promise<CapturedServerAction> {
  const requestPromise = page.waitForRequest(
    (request) => request.method() === 'POST' && Boolean(request.headers()['next-action']),
  )
  await submit()
  const request: Request = await requestPromise
  const body = request.postDataBuffer()
  if (!body) throw new Error('Captured Server Action has no request body.')
  return {
    body,
    headers: await request.allHeaders(),
    url: request.url(),
  }
}

async function replayServerAction(
  page: Page,
  action: CapturedServerAction,
  expectedStatuses: readonly number[] = [200],
): Promise<string> {
  const response = await page.context().request.fetch(action.url, {
    method: 'POST',
    headers: action.headers,
    data: action.body,
    failOnStatusCode: false,
    maxRedirects: 0,
  })
  const body = await response.text()
  expect(expectedStatuses, body).toContain(response.status())
  return body
}

async function setHiddenCommandId(form: ReturnType<Page['locator']>, value: string) {
  await form.locator('input[name="commandId"]').evaluate((input, commandId) => {
    ;(input as HTMLInputElement).value = commandId
  }, value)
}

async function workoutFacts(sessionId: string): Promise<unknown> {
  const client = await databaseClient()
  try {
    const result = await client.query(
      `SELECT
        (SELECT row_to_json(session_row)
         FROM (
           SELECT id, status, optimistic_version, completion_command_id,
                  completed_at, updated_at
           FROM workout_session WHERE id = $1
         ) AS session_row) AS session,
        (SELECT json_agg(row_to_json(exercise_row) ORDER BY ordinal)
         FROM (
           SELECT id, exercise_code, original_exercise_code, substitution_reason,
                  ordinal
           FROM session_exercise WHERE session_id = $1
         ) AS exercise_row) AS exercises,
        (SELECT json_agg(row_to_json(set_row) ORDER BY session_exercise_id, ordinal)
         FROM (
           SELECT performed_set.*
           FROM performed_set
           JOIN session_exercise
             ON session_exercise.id = performed_set.session_exercise_id
           WHERE session_exercise.session_id = $1
         ) AS set_row) AS sets,
        (SELECT json_agg(row_to_json(receipt_row) ORDER BY command_id)
         FROM (
           SELECT command_id, command_type, target_id, request_hash, result_snapshot
           FROM training_command_receipt WHERE session_id = $1
         ) AS receipt_row) AS receipts,
        (SELECT json_agg(row_to_json(feedback_row))
         FROM (
           SELECT session_id, pain_reported, details, answered_at
           FROM session_feedback WHERE session_id = $1
         ) AS feedback_row) AS feedback,
        (SELECT json_agg(row_to_json(decision_row) ORDER BY id)
         FROM (
           SELECT id, session_id, exercise_code, decision, current_load_grams,
                  next_load_grams, reason_code, rule_version, applied_revision_id,
                  created_at
           FROM adjustment_decision WHERE session_id = $1
         ) AS decision_row) AS decisions,
        (SELECT json_agg(row_to_json(revision_row) ORDER BY revision_number)
         FROM (
           SELECT id, revision_number, status, output_hash, activated_at
           FROM program_revision
         ) AS revision_row) AS revisions`,
      [sessionId],
    )
    return result.rows[0]
  } finally {
    await client.end()
  }
}

async function currentSessionId(): Promise<string> {
  const client = await databaseClient()
  try {
    const result = await client.query<{ id: string }>(
      'SELECT id FROM workout_session ORDER BY created_at DESC LIMIT 1',
    )
    const id = result.rows[0]?.id
    if (!id) throw new Error('E2E workout session is unavailable.')
    return id
  } finally {
    await client.end()
  }
}

test.beforeEach(async () => {
  await clearApplicationData()
  await closeDb()
  await restartE2eApplication()
})

test('replays real set and completion actions across restarts while substitution stays denied', async ({
  page,
}) => {
  await bootstrapAndSignIn(page)
  await completeSetupAndStartWorkout(page)
  const sessionId = await currentSessionId()

  const substitutionForm = page
    .getByRole('button', { name: 'Propose substitute' })
    .first()
    .locator('xpath=ancestor::form')
  await substitutionForm.getByLabel('Requested exercise').fill('Front squat')
  await setHiddenCommandId(substitutionForm, '01900000-0000-7000-8000-000000000022')
  const beforeSubstitution = await workoutFacts(sessionId)
  const substitutionAction = await captureServerAction(page, () =>
    substitutionForm.getByRole('button', { name: 'Propose substitute' }).click(),
  )
  const substitutionAlert = page
    .getByRole('alert')
    .filter({ hasText: 'Substitution not applied' })
    .first()
  await expect(substitutionAlert).toBeVisible()
  await expect(substitutionAlert).toBeFocused()
  await expect(substitutionAlert).toContainText(
    'No reviewed, equipment-compatible substitution release is installed.',
  )
  expect(await workoutFacts(sessionId)).toEqual(beforeSubstitution)

  const firstSetForm = page
    .getByRole('button', { name: 'Complete set' })
    .first()
    .locator('xpath=ancestor::form')
  await firstSetForm.getByLabel('RPE (optional)').fill('8')
  await setHiddenCommandId(firstSetForm, '01900000-0000-7000-8000-000000000023')
  const firstSetAction = await captureServerAction(page, () =>
    firstSetForm.getByRole('button', { name: 'Complete set' }).click(),
  )
  await expect(page.getByRole('button', { name: 'Complete set' })).toHaveCount(8)

  const afterFirstSet = await workoutFacts(sessionId)
  await restartE2eApplication()
  await replayServerAction(page, firstSetAction)
  expect(await workoutFacts(sessionId)).toEqual(afterFirstSet)

  const beforeSubstitutionReplay = await workoutFacts(sessionId)
  const denialReplay = await replayServerAction(page, substitutionAction)
  expect(denialReplay).toContain('substitution.unapproved')
  expect(await workoutFacts(sessionId)).toEqual(beforeSubstitutionReplay)

  await page.goto(`/workouts/${sessionId}`)
  let remaining = await page.getByRole('button', { name: 'Complete set' }).count()
  while (remaining > 0) {
    const button = page.getByRole('button', { name: 'Complete set' }).first()
    await button.locator('xpath=ancestor::form').getByLabel('RPE (optional)').fill('8')
    await button.click()
    remaining -= 1
    await expect(page.getByRole('button', { name: 'Complete set' })).toHaveCount(
      remaining,
    )
  }

  const completionForm = page
    .getByRole('button', { name: 'Complete workout' })
    .locator('xpath=ancestor::form')
  await completionForm
    .getByLabel(
      'I confirm that I am not reporting pain or a safety issue from this session.',
    )
    .check()
  await setHiddenCommandId(completionForm, '01900000-0000-7000-8000-000000000024')
  const completionAction = await captureServerAction(page, () =>
    completionForm.getByRole('button', { name: 'Complete workout' }).click(),
  )
  await expect(page).toHaveURL(new RegExp(`/history/${sessionId}`))
  await expect(page.getByRole('heading', { name: 'Workout completed.' })).toBeVisible()

  const afterCompletion = await workoutFacts(sessionId)
  await restartE2eApplication()
  await replayServerAction(page, completionAction, [303])
  expect(await workoutFacts(sessionId)).toEqual(afterCompletion)

  const client = await databaseClient()
  try {
    const receipts = await client.query<{ command_type: string; count: number }>(
      `SELECT command_type, count(*)::int AS count
       FROM training_command_receipt
       WHERE command_id IN ($1, $2, $3)
       GROUP BY command_type
       ORDER BY command_type`,
      [
        '01900000-0000-7000-8000-000000000022',
        '01900000-0000-7000-8000-000000000023',
        '01900000-0000-7000-8000-000000000024',
      ],
    )
    expect(receipts.rows).toEqual([
      { command_type: 'complete-set', count: 1 },
      { command_type: 'complete-workout', count: 1 },
    ])
  } finally {
    await client.end()
  }
})
