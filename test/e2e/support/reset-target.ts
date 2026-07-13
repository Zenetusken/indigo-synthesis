import { validateLocalE2eResetTarget } from '@/platform/db/e2e-reset-guard'

/**
 * Playwright can evaluate its config again after test modules have rebound DATABASE_URL
 * to the disposable target. Pin the original administration URL in the parent process so
 * every worker validates against the same immutable pair.
 */
export const e2eAdministrationUrlEnvironment = 'INDIGO_E2E_ADMINISTRATION_DATABASE_URL'

export function pinE2eAdministrationUrl(targetUrl: string | undefined): string {
  const administrationUrl =
    process.env[e2eAdministrationUrlEnvironment] ?? process.env.DATABASE_URL
  validateLocalE2eResetTarget(administrationUrl, targetUrl)
  if (!administrationUrl) {
    throw new Error('DATABASE_URL is required before Playwright can reset E2E data.')
  }
  process.env[e2eAdministrationUrlEnvironment] = administrationUrl
  return administrationUrl
}
