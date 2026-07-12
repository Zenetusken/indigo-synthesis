import { describe, expect, it } from 'vitest'
import { validateLocalE2eResetTarget } from './e2e-reset-guard'

const administrationUrl =
  'postgresql://indigo:admin-secret@127.0.0.1:5432/indigo_synthesis'
const targetUrl = 'postgresql://indigo:e2e-secret@127.0.0.1:5432/indigo_synthesis_e2e'

describe('local E2E reset target guard', () => {
  it('returns the validated target database name', () => {
    expect(validateLocalE2eResetTarget(administrationUrl, targetUrl)).toBe(
      'indigo_synthesis_e2e',
    )
  })

  it('accepts either PostgreSQL scheme and treats an omitted port as 5432', () => {
    expect(
      validateLocalE2eResetTarget(
        'postgres://indigo:secret@localhost/indigo_synthesis',
        'postgresql://indigo:secret@localhost:5432/indigo_browser_e2e',
      ),
    ).toBe('indigo_browser_e2e')
  })

  it.each([
    [undefined, targetUrl, 'DATABASE_URL is required'],
    [administrationUrl, undefined, 'E2E_DATABASE_URL is required'],
    ['not a URL', targetUrl, 'DATABASE_URL must be a valid PostgreSQL URL'],
    [
      administrationUrl,
      'https://indigo:secret@127.0.0.1/indigo_browser_e2e',
      'E2E_DATABASE_URL must use the postgres: or postgresql: scheme',
    ],
    [
      administrationUrl,
      'postgresql://indigo:secret@127.0.0.1/indigo_browser_e2e?host=database.internal',
      'E2E_DATABASE_URL must not use query parameters',
    ],
  ])('rejects a missing or non-PostgreSQL URL', (administration, target, message) => {
    expect(() => validateLocalE2eResetTarget(administration, target)).toThrow(message)
  })

  it.each([
    'indigo_e2e',
    'indigo__e2e',
    'indigo_synthesis_test',
    'other_synthesis_e2e',
    'indigo-Synthesis-e2e',
    'indigo_synthesis_e2e_extra',
  ])('rejects the non-conforming target database %s', (databaseName) => {
    expect(() =>
      validateLocalE2eResetTarget(
        administrationUrl,
        `postgresql://indigo:secret@127.0.0.1:5432/${databaseName}`,
      ),
    ).toThrow('must match indigo_<name>_e2e')
  })

  it('rejects the administrative database as the reset target', () => {
    const sharedDatabase =
      'postgresql://indigo:secret@127.0.0.1:5432/indigo_synthesis_e2e'

    expect(() => validateLocalE2eResetTarget(sharedDatabase, sharedDatabase)).toThrow(
      'must differ',
    )
  })

  it.each([
    [
      'postgresql://indigo:secret@database.internal:5432/indigo_synthesis',
      'postgresql://indigo:secret@database.internal:5432/indigo_synthesis_e2e',
      'explicit loopback host',
    ],
    [
      'postgresql://indigo:secret@localhost:5432/indigo_synthesis',
      'postgresql://indigo:secret@127.0.0.1:5432/indigo_synthesis_e2e',
      'exactly the same host',
    ],
    [
      administrationUrl,
      'postgresql://indigo:secret@127.0.0.1:55432/indigo_synthesis_e2e',
      'same effective PostgreSQL port',
    ],
    [
      administrationUrl,
      'postgresql://another-user:secret@127.0.0.1:5432/indigo_synthesis_e2e',
      'exactly the same PostgreSQL username',
    ],
    [
      'postgresql://127.0.0.1:5432/indigo_synthesis',
      'postgresql://127.0.0.1:5432/indigo_synthesis_e2e',
      'explicit PostgreSQL username',
    ],
  ])('rejects reset endpoints outside the exact local server identity', (admin, target, message) => {
    expect(() => validateLocalE2eResetTarget(admin, target)).toThrow(message)
  })

  it('compares decoded PostgreSQL usernames', () => {
    expect(
      validateLocalE2eResetTarget(
        'postgresql://indigo%2Ddev:secret@[::1]/indigo_synthesis',
        'postgresql://indigo%2Ddev:secret@[::1]/indigo_ipv6_e2e',
      ),
    ).toBe('indigo_ipv6_e2e')
  })
})
