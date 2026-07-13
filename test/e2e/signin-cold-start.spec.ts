import { expect, test } from '@playwright/test'
import { closeDb } from '@/platform/db/client'
import {
  bindE2eProcessEnv,
  bootstrapAndSignIn,
  clearApplicationData,
  expectNoHorizontalOverflow,
} from './support/journey'
import { restartE2eApplication } from './support/supervisor-client'

bindE2eProcessEnv()

test.beforeEach(async () => {
  await clearApplicationData()
  await closeDb()
  await restartE2eApplication()
})

test('orients every J9 persona without exposing recovery on an open instance', async ({
  page,
}) => {
  for (const path of ['/sign-in', '/reset', '/recover']) {
    await page.goto(path)
    await expect(page).toHaveURL(/\/bootstrap$/)
  }

  await bootstrapAndSignIn(page)
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/sign-in\?signedOut=1$/)

  await expect(
    page.getByRole('link', {
      name: 'Indigo Synthesis Development content mode',
    }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  const disclosure = page.locator('details').filter({ hasText: "Can't sign in?" })
  await expect(disclosure).not.toHaveAttribute('open', '')
  await disclosure.locator('summary').click()
  await expect(disclosure).toHaveAttribute('open', '')

  await expect(
    page.getByRole('link', { name: 'Use a trainee reset code' }),
  ).toHaveAttribute('href', '/reset')
  await expect(
    page.getByText(/Ask this instance’s owner for a one-use password reset code/),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Use a host-issued owner recovery code' }),
  ).toHaveAttribute('href', '/recover')
  await expect(page.getByText(/pnpm owner:recover issue/)).toBeVisible()
  await expect(page.getByText(/Public signup is not available/)).toBeVisible()
  await expect(page.getByRole('link', { name: /sign up/i })).toHaveCount(0)

  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page)
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%'
  })
  await expectNoHorizontalOverflow(page)
})
