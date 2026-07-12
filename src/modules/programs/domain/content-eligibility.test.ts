import { describe, expect, it } from 'vitest'
import { evaluatePersistedContentEligibility } from './content-eligibility'

describe('persisted content eligibility', () => {
  it.each([
    'methodologyStatus',
    'templateStatus',
  ] as const)('always denies prohibited %s', (field) => {
    expect(
      evaluatePersistedContentEligibility({
        contentMode: 'development',
        methodologyStatus: 'reviewed',
        templateStatus: 'reviewed',
        [field]: 'prohibited',
      }),
    ).toEqual({ eligible: false, code: 'content.prohibited' })
  })

  it('always denies expired content', () => {
    expect(
      evaluatePersistedContentEligibility({
        contentMode: 'development',
        methodologyStatus: 'expired',
        templateStatus: 'reviewed',
      }),
    ).toEqual({ eligible: false, code: 'content.expired' })
  })

  it('requires both releases to be reviewed in reviewed mode', () => {
    expect(
      evaluatePersistedContentEligibility({
        contentMode: 'reviewed',
        methodologyStatus: 'development',
        templateStatus: 'reviewed',
      }),
    ).toEqual({
      eligible: false,
      code: 'content.development-forbidden-in-production',
    })
  })

  it('allows visibly labeled development content only in development mode', () => {
    expect(
      evaluatePersistedContentEligibility({
        contentMode: 'development',
        methodologyStatus: 'development',
        templateStatus: 'development',
      }),
    ).toEqual({ eligible: true })
  })
})
