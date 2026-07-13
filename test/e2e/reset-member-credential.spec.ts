import { expect, test } from '@playwright/test'
import { closeDb } from '@/platform/db/client'
import {
  bindE2eProcessEnv,
  bootstrapAndSignIn,
  clearApplicationData,
  completeAllSetsAtTarget,
  completeSetup,
  completeWorkoutToHistory,
  databaseClient,
  e2eOwner,
  generateAndActivate,
} from './support/journey'
import { restartE2eApplication } from './support/supervisor-client'

const member = {
  name: 'Recovery Trainee',
  email: 'recovery-trainee@example.test',
  originalPassword: 'recovery-trainee-original-password',
  replacementPassword: 'recovery-trainee-replacement-password',
} as const

bindE2eProcessEnv()

test.beforeEach(async () => {
  await clearApplicationData()
  await closeDb()
  await restartE2eApplication()
})

test('completes J7 with session revocation and exact mid-workout resume', async ({
  browser,
  page: ownerPage,
}) => {
  await bootstrapAndSignIn(ownerPage)
  await ownerPage.goto('/settings')
  await ownerPage.getByLabel('Name').fill(member.name)
  await ownerPage.getByLabel('Local sign-in email').fill(member.email)
  await ownerPage.getByLabel('Initial password').fill(member.originalPassword)
  await ownerPage.getByLabel('Current owner password').fill(e2eOwner.password)
  await ownerPage.getByRole('button', { name: 'Create local user' }).click()
  await expect(ownerPage.getByText(`Local user ${member.email} created.`)).toBeVisible()

  const memberContext = await browser.newContext()
  const recoveryContext = await browser.newContext()
  const memberPage = await memberContext.newPage()
  const recoveryPage = await recoveryContext.newPage()
  try {
    await memberPage.goto('/sign-in')
    await memberPage.getByLabel('Email').fill(member.email)
    await memberPage.getByLabel('Password').fill(member.originalPassword)
    await memberPage.getByRole('button', { name: 'Sign in' }).click()
    await expect(memberPage).toHaveURL(/\/setup$/)
    await completeSetup(memberPage)
    await generateAndActivate(memberPage)
    await memberPage.getByRole('button', { name: 'Start workout' }).click()
    await expect(memberPage).toHaveURL(/\/workouts\//)

    const savedWorkoutPath = new URL(memberPage.url()).pathname
    const completeButtons = memberPage.getByRole('button', { name: 'Complete set' })
    const initialPendingSets = await completeButtons.count()
    expect(initialPendingSets).toBeGreaterThan(1)
    const firstSetForm = completeButtons.first().locator('xpath=ancestor::form')
    await firstSetForm.getByLabel('RPE (optional)').fill('8')
    await completeButtons.first().click()
    await expect(completeButtons).toHaveCount(initialPendingSets - 1)

    await ownerPage.goto('/settings')
    const memberRow = ownerPage.getByRole('listitem').filter({ hasText: member.email })
    await memberRow.getByText('Issue password reset code').click()
    await memberRow
      .getByLabel(`Current owner password for ${member.name}`)
      .fill(e2eOwner.password)
    await memberRow.getByRole('button', { name: 'Issue one-time code' }).click()
    const resetCode = (await memberRow.locator('code').textContent())?.trim()
    expect(resetCode).toMatch(/^indigo_m1_[A-Za-z0-9_-]{43}$/)
    if (!resetCode) throw new Error('The owner UI did not expose the one-time code.')

    await recoveryPage.goto('/reset')
    await recoveryPage.getByLabel('Local sign-in email').fill(member.email)
    await recoveryPage.getByLabel('Owner-issued reset code').fill(resetCode)
    await recoveryPage
      .getByLabel('New password', { exact: true })
      .fill(member.replacementPassword)
    await recoveryPage.getByLabel('Confirm new password').fill(member.replacementPassword)
    await recoveryPage.getByRole('button', { name: 'Reset password' }).click()
    await expect(recoveryPage).toHaveURL(/\/sign-in\?reset=1$/)
    expect(recoveryPage.url()).not.toContain(resetCode)

    const revokedClient = await databaseClient()
    try {
      const sessions = await revokedClient.query<{ count: string }>(
        `SELECT count(*)
         FROM "session" s
         JOIN "user" u ON u.id = s.user_id
         WHERE u.email = $1`,
        [member.email],
      )
      expect(Number(sessions.rows[0]?.count)).toBe(0)
    } finally {
      await revokedClient.end()
    }

    await recoveryPage.getByLabel('Email').fill(member.email)
    await recoveryPage.getByLabel('Password').fill(member.originalPassword)
    await recoveryPage.getByRole('button', { name: 'Sign in' }).click()
    await expect(
      recoveryPage.getByRole('alert').filter({ hasText: 'Sign-in failed' }),
    ).toContainText('The email or password was not accepted.')

    await completeButtons.first().click()
    await expect(memberPage).toHaveURL(/\/sign-in\?expired=1&returnTo=/)
    expect(new URL(memberPage.url()).searchParams.get('returnTo')).toBe(savedWorkoutPath)
    await expect(
      memberPage.getByText(
        'Your session ended. Sign in again to resume your saved workout.',
      ),
    ).toBeVisible()
    await memberPage.getByLabel('Email').fill(member.email)
    await memberPage.getByLabel('Password').fill(member.replacementPassword)
    await memberPage.getByRole('button', { name: 'Sign in' }).click()
    await expect(memberPage).toHaveURL(new RegExp(`${savedWorkoutPath}$`))
    await expect(memberPage.getByRole('button', { name: 'Complete set' })).toHaveCount(
      initialPendingSets - 1,
    )

    await completeAllSetsAtTarget(memberPage)
    await completeWorkoutToHistory(memberPage)

    const evidenceClient = await databaseClient()
    try {
      const preserved = await evidenceClient.query<{
        profiles: string
        programs: string
        completed_sessions: string
        performed_sets: string
      }>(
        `SELECT
           (SELECT count(*) FROM athlete_profile ap WHERE ap.user_id = u.id) AS profiles,
           (SELECT count(*) FROM program p WHERE p.user_id = u.id) AS programs,
           (SELECT count(*) FROM workout_session ws WHERE ws.user_id = u.id AND ws.status = 'completed') AS completed_sessions,
           (SELECT count(*)
            FROM performed_set ps
            JOIN session_exercise se ON se.id = ps.session_exercise_id
            JOIN workout_session ws ON ws.id = se.session_id
            WHERE ws.user_id = u.id) AS performed_sets
         FROM "user" u
         WHERE u.email = $1`,
        [member.email],
      )
      expect(Number(preserved.rows[0]?.profiles)).toBe(1)
      expect(Number(preserved.rows[0]?.programs)).toBe(1)
      expect(Number(preserved.rows[0]?.completed_sessions)).toBe(1)
      expect(Number(preserved.rows[0]?.performed_sets)).toBeGreaterThan(1)

      const audits = await evidenceClient.query<{
        event_type: string
        metadata: Record<string, unknown>
      }>(
        `SELECT event_type, metadata
         FROM audit_event
         WHERE entity_type = 'member-reset'
         ORDER BY created_at, id`,
      )
      expect(audits.rows.map((event) => event.event_type)).toEqual([
        'member-reset-issued',
        'member-reset-redeemed',
      ])
      expect(audits.rows[1]?.metadata).toMatchObject({
        channel: 'web',
        clientAddress: '127.0.0.0/24',
        outcome: 'redeemed',
      })
      const serialized = JSON.stringify(audits.rows)
      expect(serialized).not.toContain(resetCode)
      expect(serialized).not.toContain(member.originalPassword)
      expect(serialized).not.toContain(member.replacementPassword)
    } finally {
      await evidenceClient.end()
    }
  } finally {
    await memberContext.close()
    await recoveryContext.close()
  }
})
