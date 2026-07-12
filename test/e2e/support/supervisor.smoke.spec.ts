import { expect, test } from '@playwright/test'
import { readE2eSupervisorState, restartE2eApplication } from './supervisor-client'

test('the E2E supervisor replaces a ready Next.js generation', async ({ request }) => {
  const before = await readE2eSupervisorState()
  expect(before.phase).toBe('ready')
  expect(before.pid).toBeGreaterThan(0)

  const after = await restartE2eApplication()
  expect(after).toEqual({
    phase: 'ready',
    generation: before.generation + 1,
    pid: expect.any(Number),
  })
  expect(after.pid).not.toBe(before.pid)

  const applicationResponse = await request.get('/')
  expect(applicationResponse.ok()).toBe(true)
})
