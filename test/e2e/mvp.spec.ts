import { expect, type Page, test } from '@playwright/test'
import { Client } from 'pg'
import { issueOwnerBootstrap } from '@/modules/identity/bootstrap/owner-bootstrap'
import {
  type ExecutablePrescriptionProjection,
  executablePrescriptionHash,
} from '@/modules/programs/domain/executable-prescription'
import { resetServerConfigForTests } from '@/platform/config/server'
import { closeDb } from '@/platform/db/client'

// Server-side modules read DATABASE_URL and BETTER_AUTH_SECRET; the E2E harness
// exposes the real target as E2E_DATABASE_URL and E2E_BETTER_AUTH_SECRET. Point
// the test process at the same database and secret before any server-side import
// resolves its configuration.
process.env.DATABASE_URL = process.env.E2E_DATABASE_URL
process.env.BETTER_AUTH_SECRET = process.env.E2E_BETTER_AUTH_SECRET
resetServerConfigForTests()

const owner = {
  name: 'E2E Owner',
  email: 'owner@example.test',
  password: 'correct-horse-battery-staple',
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
  await expect(
    page.getByRole('heading', { name: 'Initialize this instance.' }),
  ).toBeVisible()
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

async function completeSetup(
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

async function generateAndActivate(page: Page): Promise<void> {
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

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
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

test.beforeEach(async () => {
  await clearApplicationData()
})

test('rejects bootstrap with an invalid or missing code', async ({ page }) => {
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: 'Initialize this instance.' }),
  ).toBeVisible()

  await page.getByLabel('Name').fill(owner.name)
  await page.getByLabel('Local sign-in email').fill(owner.email)
  await page.locator('input[name="password"]').fill(owner.password)
  await page.getByLabel('Confirm password').fill(owner.password)
  await page.getByRole('button', { name: 'Create owner account' }).click()

  await expect(page.locator('form [role="alert"]')).toContainText(
    'Owner account not created',
  )
  await expect(page).toHaveURL(/\/bootstrap/)
})

test('completes the unmocked J1–J6 development journey', async ({ page }) => {
  await bootstrapAndSignIn(page)
  await completeSetup(page)
  await generateAndActivate(page)

  await page.getByRole('button', { name: 'Start workout' }).click()
  await expect(page).toHaveURL(/\/workouts\//)
  await expect(page.getByText(/Substitution unavailable/).first()).toBeVisible()

  let remaining = await page.getByRole('button', { name: 'Complete set' }).count()
  expect(remaining).toBeGreaterThan(0)
  while (remaining > 0) {
    const button = page.getByRole('button', { name: 'Complete set' }).first()
    const form = button.locator('xpath=ancestor::form')
    await form.getByLabel('RPE (optional)').fill('8')
    await button.click()
    await expect(page.getByText(/Draft saved in PostgreSQL/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Complete set' })).toHaveCount(
      remaining - 1,
    )
    if (remaining > 1) {
      await expect(page.getByText('Timestamp-derived rest context')).toBeVisible()
    }
    remaining -= 1
  }

  await page
    .getByLabel(
      'I confirm that I am not reporting pain or a safety issue from this session.',
    )
    .check()
  await page.getByRole('button', { name: 'Complete workout' }).click()
  await expect(page).toHaveURL(/\/history\//)
  await expect(page.getByRole('heading', { name: 'Workout completed.' })).toBeVisible()
  await expect(page.getByText('Persisted immutable completion facts')).toBeVisible()

  await page.goto('/today')
  await expect(
    page.getByRole('heading', { name: 'Today’s workout is complete.' }),
  ).toBeVisible()

  const revisionClient = await databaseClient()
  try {
    const revisions = await revisionClient.query<{
      revision_number: number
      status: string
    }>('SELECT revision_number, status FROM program_revision ORDER BY revision_number')
    const completedTarget = await revisionClient.query<{ target_load_grams: number }>(
      `SELECT ps.target_load_grams
       FROM performed_set ps
       JOIN session_exercise se ON se.id = ps.session_exercise_id
       WHERE se.exercise_code = 'development.back-squat'
       ORDER BY ps.ordinal
       LIMIT 1`,
    )
    const futureTarget = await revisionClient.query<{ target_load_grams: number }>(
      `SELECT sp.target_load_grams
       FROM set_prescription sp
       JOIN exercise_prescription ep ON ep.id = sp.exercise_prescription_id
       JOIN planned_workout pw ON pw.id = ep.planned_workout_id
       JOIN program_revision pr ON pr.id = pw.revision_id
       WHERE pr.status = 'active'
         AND ep.exercise_code = 'development.back-squat'
       ORDER BY pw.ordinal, sp.ordinal
       LIMIT 1`,
    )

    expect(revisions.rows).toEqual([
      { revision_number: 1, status: 'superseded' },
      { revision_number: 2, status: 'active' },
    ])
    expect(completedTarget.rows[0]?.target_load_grams).toBe(60_000)
    expect(futureTarget.rows[0]?.target_load_grams).toBe(61_000)
  } finally {
    await revisionClient.end()
  }

  const exportResponse = await page.context().request.get('/api/export')
  expect(exportResponse.status()).toBe(200)
  expect(exportResponse.headers()['content-type']).toContain('application/json')
  const archive = (await exportResponse.json()) as {
    manifest: { schemaVersion: string; omissions: unknown[] }
    programs: { revisions: unknown[] }[]
    sessions: unknown[]
  }
  expect(archive.manifest.schemaVersion).toBe('1.2.0-development')
  expect(archive.manifest.omissions.length).toBeGreaterThan(0)
  expect(archive.programs).toHaveLength(1)
  expect(archive.programs[0]?.revisions).toHaveLength(2)
  expect(archive.sessions).toHaveLength(1)
  expect(JSON.stringify(archive)).not.toContain('correct-horse-battery-staple')

  await page.goto('/settings')
  await page.getByLabel('Name').fill('Second Trainee')
  await page.getByLabel('Local sign-in email').fill('second@example.test')
  await page.getByLabel('Initial password').fill('second-user-password')
  await page.getByRole('button', { name: 'Create local user' }).click()
  await expect(page.getByText('Local user second@example.test created.')).toBeVisible()

  await page.getByRole('link', { name: 'Review instance reset' }).click()
  await page.getByRole('button', { name: 'Generate exact reset preview' }).click()
  await expect(
    page.getByRole('heading', { name: 'Exact rows in this preview' }),
  ).toBeVisible()
  await page.getByLabel('Current owner password').fill(owner.password)
  await page.getByLabel('Type RESET').fill('RESET')
  await page
    .getByLabel('I understand that live-instance data cannot be recovered after commit.')
    .check()
  await page.getByRole('button', { name: 'Reset instance' }).click()

  await expect(page).toHaveURL(/\/bootstrap\?reset=complete/)
  await expect(
    page.getByText('Instance reset. Create a new owner to begin again.'),
  ).toBeVisible()

  const client = await databaseClient()
  try {
    const users = await client.query<{ count: string }>('SELECT count(*) FROM "user"')
    const tombstones = await client.query<{ count: string }>(
      'SELECT count(*) FROM deletion_tombstone',
    )
    expect(Number(users.rows[0]?.count)).toBe(0)
    expect(Number(tombstones.rows[0]?.count)).toBe(1)
  } finally {
    await client.end()
  }
})

test('a reported restriction blocks program creation in the browser and database', async ({
  page,
}) => {
  await bootstrapAndSignIn(page)
  await completeSetup(page, 'present')
  await page.getByLabel('Program start date').fill(todayIso())
  await page.getByRole('button', { name: 'Create development program' }).click()
  await expect(page.getByText(/blocks this development program/)).toBeVisible()

  const client = await databaseClient()
  try {
    const result = await client.query<{ count: string }>('SELECT count(*) FROM program')
    expect(Number(result.rows[0]?.count)).toBe(0)
  } finally {
    await client.end()
  }
})

test('a pain report atomically pauses training and creates a safety hold', async ({
  page,
}) => {
  await bootstrapAndSignIn(page)
  await completeSetup(page)
  await generateAndActivate(page)
  await page.getByRole('button', { name: 'Start workout' }).click()

  await page.getByLabel('Optional factual context').fill('User-reported shoulder pain')
  await page.getByRole('button', { name: 'Stop and report issue' }).click()
  await expect(
    page.getByRole('heading', { name: 'Training stopped for a reported issue' }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume workout' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Complete set' })).toHaveCount(0)

  const client = await databaseClient()
  try {
    const session = await client.query<{ status: string }>(
      'SELECT status FROM workout_session LIMIT 1',
    )
    const holds = await client.query<{ count: string }>(
      'SELECT count(*) FROM safety_hold WHERE cleared_at IS NULL',
    )
    expect(session.rows[0]?.status).toBe('paused')
    expect(Number(holds.rows[0]?.count)).toBe(1)
  } finally {
    await client.end()
  }
})

test('an ineligible advanced prescription is denied before session creation', async ({
  page,
}) => {
  await bootstrapAndSignIn(page)
  await completeSetup(page)
  await page.getByLabel('Program start date').fill(todayIso())
  await page.getByRole('button', { name: 'Create development program' }).click()
  await expect(
    page.getByRole('heading', { name: 'Two-cycle A/B/C fixture' }),
  ).toBeVisible()

  const client = await databaseClient()
  try {
    const revision = await client.query<{
      id: string
      output_snapshot: ExecutablePrescriptionProjection
    }>("SELECT id, output_snapshot FROM program_revision WHERE status = 'draft'")
    const draftRevision = revision.rows[0]
    if (!draftRevision) throw new Error('Expected a draft revision before activation.')
    const advancedSnapshot: ExecutablePrescriptionProjection = {
      ...draftRevision.output_snapshot,
      workouts: draftRevision.output_snapshot.workouts.map((workout) => ({
        ...workout,
        exercises:
          workout.scheduledDate === todayIso()
            ? workout.exercises.map((exercise) => ({
                ...exercise,
                safetyTier: 'advanced',
              }))
            : workout.exercises,
      })),
    }
    await client.query(
      `UPDATE program_revision
       SET output_snapshot = $1::jsonb, output_hash = $2
       WHERE id = $3`,
      [
        JSON.stringify(advancedSnapshot),
        executablePrescriptionHash(advancedSnapshot),
        draftRevision.id,
      ],
    )
    await client.query(
      `UPDATE exercise_prescription
       SET safety_tier = 'advanced'
       WHERE planned_workout_id = (
         SELECT id FROM planned_workout WHERE scheduled_date = $1 LIMIT 1
       )`,
      [todayIso()],
    )
  } finally {
    await client.end()
  }

  await page.getByRole('button', { name: 'Activate development program' }).click()
  await expect(page).toHaveURL(/\/program\?error=safety\.advanced-ineligible/)
  await expect(page.getByText(/without an approved eligibility rule/)).toBeVisible()

  const verificationClient = await databaseClient()
  try {
    const sessions = await verificationClient.query<{ count: string }>(
      'SELECT count(*) FROM workout_session',
    )
    const programs = await verificationClient.query<{ status: string }>(
      'SELECT status FROM program',
    )
    const revisions = await verificationClient.query<{ status: string }>(
      'SELECT status FROM program_revision',
    )
    expect(Number(sessions.rows[0]?.count)).toBe(0)
    expect(programs.rows).toEqual([{ status: 'draft' }])
    expect(revisions.rows).toEqual([{ status: 'draft' }])
  } finally {
    await verificationClient.end()
  }
})

test('a second local user cannot read the owner workout or export', async ({ page }) => {
  await bootstrapAndSignIn(page)
  await completeSetup(page)
  await generateAndActivate(page)
  await page.getByRole('button', { name: 'Start workout' }).click()
  await expect(page).toHaveURL(/\/workouts\//)
  const ownerWorkoutUrl = page.url()

  await page.goto('/settings')
  await page.getByLabel('Name').fill('Isolated Member')
  await page.getByLabel('Local sign-in email').fill('isolated@example.test')
  await page.getByLabel('Initial password').fill('isolated-user-password')
  await page.getByRole('button', { name: 'Create local user' }).click()
  await expect(page.getByText('Local user isolated@example.test created.')).toBeVisible()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/sign-in\?signedOut=1/)

  await page.getByLabel('Email').fill('isolated@example.test')
  await page.getByLabel('Password').fill('isolated-user-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/setup$/)

  await page.goto(ownerWorkoutUrl)
  await expect(
    page.getByRole('heading', { name: 'This record is unavailable.' }),
  ).toBeVisible()

  const memberExportResponse = await page.context().request.get('/api/export')
  expect(memberExportResponse.status()).toBe(200)
  const memberArchive = (await memberExportResponse.json()) as {
    identity: { email: string }
    profile: { profile: unknown }
    programs?: unknown[]
    sessions: unknown[]
  }
  expect(memberArchive.identity.email).toBe('isolated@example.test')
  expect(memberArchive.profile.profile).toBeNull()
  expect(memberArchive.programs ?? []).toHaveLength(0)
  expect(memberArchive.sessions).toHaveLength(0)

  await page.goto('/settings')
  await page.getByRole('link', { name: 'Review account deletion' }).click()
  await page
    .getByRole('button', { name: 'Generate exact account-deletion preview' })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Exact affected rows in this preview' }),
  ).toBeVisible()
  await page.getByLabel('Current password').fill('isolated-user-password')
  await page.getByLabel('Type DELETE').fill('DELETE')
  await page.getByLabel('I understand that my local account cannot be recovered.').check()
  await page.getByRole('button', { name: 'Delete my account' }).click()
  await expect(page).toHaveURL(/\/sign-in\?deleted=1/)
  await expect(
    page.getByText('Local account and subject-scoped training data deleted.'),
  ).toBeVisible()

  const deletionClient = await databaseClient()
  try {
    const users = await deletionClient.query<{ email: string }>(
      'SELECT email FROM "user" ORDER BY email',
    )
    const tombstones = await deletionClient.query<{ scope: string }>(
      'SELECT scope FROM deletion_tombstone',
    )
    expect(users.rows).toEqual([{ email: owner.email }])
    expect(tombstones.rows).toEqual([{ scope: 'trainee-data' }])
  } finally {
    await deletionClient.end()
  }
})

test('imperial display round-trips canonical grams through workout history', async ({
  page,
}) => {
  await bootstrapAndSignIn(page)
  await completeSetup(page, 'none', 'imperial')
  await generateAndActivate(page)
  await expect(page.getByText(/60 lb/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Start workout' }).click()
  await expect(page.getByLabel('Actual load (lb)').first()).toHaveValue('60.001')

  let remaining = await page.getByRole('button', { name: 'Complete set' }).count()
  while (remaining > 0) {
    const button = page.getByRole('button', { name: 'Complete set' }).first()
    const form = button.locator('xpath=ancestor::form')
    await form.getByLabel('RPE (optional)').fill('8')
    await button.click()
    await expect(page.getByRole('button', { name: 'Complete set' })).toHaveCount(
      remaining - 1,
    )
    remaining -= 1
  }

  await page
    .getByLabel(
      'I confirm that I am not reporting pain or a safety issue from this session.',
    )
    .check()
  await page.getByRole('button', { name: 'Complete workout' }).click()
  await expect(page.getByText(/60 lb/).first()).toBeVisible()

  const client = await databaseClient()
  try {
    const performed = await client.query<{
      target_load_grams: number
      actual_load_grams: number
      load_provenance: string
    }>(
      `SELECT target_load_grams, actual_load_grams, load_provenance
       FROM performed_set
       WHERE status = 'performed'
       ORDER BY confirmed_at
       LIMIT 1`,
    )
    expect(performed.rows[0]).toEqual({
      target_load_grams: 27_216,
      actual_load_grams: 27_216,
      load_provenance: 'copied-target',
    })
  } finally {
    await client.end()
  }
})

test('a set submission with an invalid value preserves entries and shows a focused alert', async ({
  page,
}) => {
  await bootstrapAndSignIn(page)
  await completeSetup(page)
  await generateAndActivate(page)
  await page.getByRole('button', { name: 'Start workout' }).click()
  await expect(page).toHaveURL(/\/workouts\//)

  const repsInput = page.getByLabel('Actual reps').first()
  const button = page.getByRole('button', { name: 'Complete set' }).first()

  // Bypass HTML5 max validation to reach server-side schema validation.
  await page.evaluate(() => {
    const input = document.querySelector(
      'input[name="actualRepetitions"]',
    ) as HTMLInputElement | null
    if (input) {
      input.removeAttribute('max')
      input.value = '999'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  await expect(repsInput).toHaveValue('999')
  await button.click()

  const alert = page.getByRole('alert').filter({ hasText: 'Command not applied' }).first()
  await expect(alert).toBeVisible()
  await expect(alert).toBeFocused()
  await expect(alert).toContainText('Check the entered values')

  // Correct the value and complete the set successfully.
  const remainingBefore = await page.getByRole('button', { name: 'Complete set' }).count()
  await repsInput.fill(String(5))
  await button.click()
  await expect(page.getByRole('button', { name: 'Complete set' })).toHaveCount(
    remainingBefore - 1,
  )
})

test('abandoning a workout requires a reason and acknowledgement and persists the reason', async ({
  page,
}) => {
  await bootstrapAndSignIn(page)
  await completeSetup(page)
  await generateAndActivate(page)
  await page.getByRole('button', { name: 'Start workout' }).click()
  await expect(page).toHaveURL(/\/workouts\//)

  await page.getByRole('button', { name: 'Abandon workout' }).click()
  await expect(page.getByLabel('Factual reason for abandoning (required)')).toBeVisible()

  // Cancel hides the panel without changing state.
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByLabel('Factual reason for abandoning (required)')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Abandon workout' })).toBeVisible()

  // Reopen and attempt confirmation without a reason.
  await page.getByRole('button', { name: 'Abandon workout' }).click()
  await page.getByRole('button', { name: 'Confirm abandon' }).click()
  const alert = page.getByRole('alert').filter({ hasText: 'Abandon not confirmed' })
  await expect(alert).toBeVisible()
  await expect(alert).toBeFocused()
  await expect(alert).toContainText('Enter a factual reason')

  // Fill the reason but omit the acknowledgement.
  await page
    .getByLabel('Factual reason for abandoning (required)')
    .fill('Gym closed early')
  await page.getByRole('button', { name: 'Confirm abandon' }).click()
  await expect(alert).toBeVisible()
  await expect(alert).toBeFocused()
  await expect(alert).toContainText('does not assess or clear symptoms')

  // Confirm with both required fields.
  await page
    .getByLabel('I understand that this product does not assess or clear symptoms.')
    .check()
  await page.getByRole('button', { name: 'Confirm abandon' }).click()
  await expect(page).toHaveURL(/\/today$/)

  const client = await databaseClient()
  try {
    const result = await client.query<{
      status: string
      abandoned_reason: string | null
    }>('SELECT status, abandoned_reason FROM workout_session LIMIT 1')
    expect(result.rows[0]?.status).toBe('abandoned')
    expect(result.rows[0]?.abandoned_reason).toBe('Gym closed early')
  } finally {
    await client.end()
  }
})

test('the core workout reflows and remains keyboard-operable on mobile', async ({
  page,
}) => {
  const nonLoopbackRequests: string[] = []
  const observeUrl = (rawUrl: string) => {
    const url = new URL(rawUrl)
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      nonLoopbackRequests.push(rawUrl)
    }
  }
  page.on('request', (request) => observeUrl(request.url()))
  page.on('websocket', (socket) => observeUrl(socket.url()))

  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })

  const titles = new Set<string>()
  const mobileBootstrap = await issueOwnerBootstrap({ ttlMinutes: 15 })
  await closeDb()

  await page.goto('/')
  await expect(page).toHaveTitle('Claim this instance | Indigo Synthesis')
  titles.add(await page.title())
  await expectNoHorizontalOverflow(page)

  await page.getByLabel('Host-issued bootstrap code').fill(mobileBootstrap.code)
  await page.getByLabel('Name').fill(owner.name)
  await page.getByLabel('Local sign-in email').fill(owner.email)
  await page.locator('input[name="password"]').fill(owner.password)
  await page.getByLabel('Confirm password').fill(owner.password)
  await page.getByRole('button', { name: 'Create owner account' }).click()
  await expect(page).toHaveTitle('Sign in | Indigo Synthesis')
  titles.add(await page.title())

  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveTitle('Training setup | Indigo Synthesis')
  titles.add(await page.title())

  await completeSetup(page)
  await expect(page).toHaveTitle('Program | Indigo Synthesis')
  titles.add(await page.title())
  await generateAndActivate(page)
  await expect(page).toHaveTitle('Today | Indigo Synthesis')
  titles.add(await page.title())

  const skipLink = page.getByRole('link', { name: 'Skip to main content' })
  await expect(skipLink).toHaveCSS('transition-duration', '0s')
  await page.keyboard.press('Tab')
  await expect(skipLink).toBeFocused()
  await page.keyboard.press('Enter')
  const mainContent = page.locator('#main-content')
  await expect(mainContent).toBeFocused()
  await expect(mainContent).toHaveCSS('outline-style', 'solid')

  await expectNoHorizontalOverflow(page)
  await page.getByRole('button', { name: 'Start workout' }).click()
  await expect(page).toHaveTitle('Active workout | Indigo Synthesis')
  titles.add(await page.title())
  expect(titles.size).toBe(6)

  const draftStatus = page
    .getByRole('status')
    .filter({ hasText: 'Draft saved in PostgreSQL' })
  const initialDraftStatus = await draftStatus.textContent()
  const firstLoad = page.getByLabel('Actual load (kg)').first()
  await expect(firstLoad).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Actual reps').first()).toBeFocused()
  await page.keyboard.press('Tab')
  const firstRpe = page.getByLabel('RPE (optional)').first()
  await expect(firstRpe).toBeFocused()
  await firstRpe.fill('8')
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Note (optional)').first()).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Complete set' }).first()).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(draftStatus).not.toHaveText(initialDraftStatus ?? '')
  await expect(page.getByLabel('Actual load (kg)').first()).toBeFocused()

  const visibleControls = page.locator(
    'main button:visible, main input:not([type="hidden"]):not([type="checkbox"]):visible',
  )
  const controlCount = await visibleControls.count()
  expect(controlCount).toBeGreaterThan(0)
  for (let index = 0; index < controlCount; index += 1) {
    const box = await visibleControls.nth(index).boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(48)
  }
  await expectNoHorizontalOverflow(page)

  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%'
  })
  await expectNoHorizontalOverflow(page)
  await expect(page.getByRole('button', { name: 'Complete set' }).first()).toBeVisible()
  expect(nonLoopbackRequests).toEqual([])
})
