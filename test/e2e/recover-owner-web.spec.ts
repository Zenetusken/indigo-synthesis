import { expect, test } from '@playwright/test'
import { issueOwnerRecovery } from '@/modules/identity/recovery/owner-recovery'
import { closeDb } from '@/platform/db/client'
import {
  bindE2eProcessEnv,
  bootstrapAndSignIn,
  clearApplicationData,
  databaseClient,
  e2eOwner,
} from './support/journey'
import { restartE2eApplication } from './support/supervisor-client'

bindE2eProcessEnv()

test.beforeEach(async () => {
  await clearApplicationData()
  await closeDb()
  await restartE2eApplication()
})

test('redeems J8 on the web, revokes the owner session, and retains redacted evidence', async ({
  browser,
  page,
}) => {
  const replacementPassword = 'owner-web-replacement-password'
  await bootstrapAndSignIn(page)
  const issued = await issueOwnerRecovery({
    ownerEmail: e2eOwner.email,
    ttlMinutes: 15,
  })
  await closeDb()

  const recoveryContext = await browser.newContext()
  const recoveryPage = await recoveryContext.newPage()
  try {
    await recoveryPage.goto('/recover')
    await recoveryPage.getByLabel('Owner sign-in email').fill(e2eOwner.email)
    await recoveryPage.getByLabel('Host-issued recovery code').fill(issued.code)
    await recoveryPage
      .getByLabel('New owner password', { exact: true })
      .fill(replacementPassword)
    await recoveryPage.getByLabel('Confirm new owner password').fill(replacementPassword)
    await recoveryPage.getByRole('button', { name: 'Recover owner account' }).click()
    await expect(recoveryPage).toHaveURL(/\/sign-in\?recovered=1$/)
    await expect(
      recoveryPage.getByText('Owner recovery complete. Sign in with your new password.'),
    ).toBeVisible()
    expect(recoveryPage.url()).not.toContain(issued.code)

    const client = await databaseClient()
    try {
      const sessions = await client.query<{ count: string }>(
        `SELECT count(*)
         FROM "session" s
         JOIN "user" u ON u.id = s.user_id
         WHERE u.email = $1`,
        [e2eOwner.email],
      )
      expect(Number(sessions.rows[0]?.count)).toBe(0)
    } finally {
      await client.end()
    }

    await page.goto('/settings')
    await expect(page).toHaveURL(/\/sign-in$/)

    await recoveryPage.getByLabel('Email').fill(e2eOwner.email)
    await recoveryPage.getByLabel('Password').fill(e2eOwner.password)
    await recoveryPage.getByRole('button', { name: 'Sign in' }).click()
    await expect(
      recoveryPage.getByRole('alert').filter({ hasText: 'Sign-in failed' }),
    ).toContainText('The email or password was not accepted.')
    await recoveryPage.getByLabel('Password').fill(replacementPassword)
    await recoveryPage.getByRole('button', { name: 'Sign in' }).click()
    await expect(recoveryPage).toHaveURL(/\/setup$/)

    const auditClient = await databaseClient()
    try {
      const evidence = await auditClient.query<{
        event_type: string
        metadata: Record<string, unknown>
      }>(
        `SELECT event_type, metadata
         FROM audit_event
         WHERE entity_type = 'owner-recovery'
         ORDER BY created_at, id`,
      )
      expect(evidence.rows.map((event) => event.event_type)).toEqual([
        'owner-recovery-issued',
        'owner-recovery-redeemed',
      ])
      expect(evidence.rows[1]?.metadata).toMatchObject({
        channel: 'web',
        clientAddress: '127.0.0.0/24',
        outcome: 'redeemed',
      })
      const serialized = JSON.stringify(evidence.rows)
      expect(serialized).not.toContain(issued.code)
      expect(serialized).not.toContain(e2eOwner.password)
      expect(serialized).not.toContain(replacementPassword)
    } finally {
      await auditClient.end()
    }
  } finally {
    await recoveryContext.close()
  }
})

test('keeps owner-recovery failures uniform and an active web throttle non-amplifying', async ({
  browser,
  page,
}) => {
  await bootstrapAndSignIn(page)
  const recoveryContext = await browser.newContext()
  const recoveryPage = await recoveryContext.newPage()
  const submittedPassword = 'uniform-recovery-password'

  async function submit(email: string, code: string): Promise<void> {
    await recoveryPage.getByLabel('Owner sign-in email').fill(email)
    const codeInput = recoveryPage.getByLabel('Host-issued recovery code')
    await codeInput.fill(code)
    await recoveryPage
      .getByLabel('New owner password', { exact: true })
      .fill(submittedPassword)
    await recoveryPage.getByLabel('Confirm new owner password').fill(submittedPassword)
    await recoveryPage.getByRole('button', { name: 'Recover owner account' }).click()
    await expect(codeInput).toHaveValue('')
    await expect(
      recoveryPage
        .getByRole('alert')
        .filter({ hasText: 'Owner recovery did not complete' }),
    ).toContainText('The email, code, or password was not accepted.')
  }

  try {
    await recoveryPage.goto('/recover')
    await submit(e2eOwner.email, 'wrong-known-owner-code')

    const floodedEmail = 'unknown-owner@example.test'
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await submit(floodedEmail, `wrong-unknown-code-${attempt}`)
    }

    const client = await databaseClient()
    try {
      const beforeThrottle = await client.query(
        `SELECT scope, bucket_key, window_started_at, attempt_count, retry_after,
                last_attempt_at, created_at, updated_at
         FROM web_recovery_rate_limit_bucket
         WHERE scope LIKE 'owner-recovery:%'
         ORDER BY scope, bucket_key`,
      )
      const rejectionsBefore = await client.query<{ count: string }>(
        `SELECT count(*)
         FROM audit_event
         WHERE event_type = 'owner-recovery-rejected'
           AND metadata->>'channel' = 'web'`,
      )
      expect(Number(rejectionsBefore.rows[0]?.count)).toBe(6)
      expect(JSON.stringify(beforeThrottle.rows)).not.toContain(floodedEmail)

      await submit(floodedEmail, 'throttled-code')

      const afterThrottle = await client.query(
        `SELECT scope, bucket_key, window_started_at, attempt_count, retry_after,
                last_attempt_at, created_at, updated_at
         FROM web_recovery_rate_limit_bucket
         WHERE scope LIKE 'owner-recovery:%'
         ORDER BY scope, bucket_key`,
      )
      const rejectionsAfter = await client.query<{ count: string }>(
        `SELECT count(*)
         FROM audit_event
         WHERE event_type = 'owner-recovery-rejected'
           AND metadata->>'channel' = 'web'`,
      )
      expect(afterThrottle.rows).toEqual(beforeThrottle.rows)
      expect(rejectionsAfter.rows[0]?.count).toBe(rejectionsBefore.rows[0]?.count)
    } finally {
      await client.end()
    }
  } finally {
    await recoveryContext.close()
  }
})
