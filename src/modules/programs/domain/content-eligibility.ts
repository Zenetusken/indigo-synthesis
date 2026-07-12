export type PersistedContentStatus = 'development' | 'reviewed' | 'expired' | 'prohibited'

export type ContentEligibilityResult =
  | { readonly eligible: true }
  | {
      readonly eligible: false
      readonly code:
        | 'content.prohibited'
        | 'content.expired'
        | 'content.development-forbidden-in-production'
    }

export function evaluatePersistedContentEligibility(input: {
  readonly contentMode: 'development' | 'reviewed'
  readonly methodologyStatus: string
  readonly templateStatus: string
}): ContentEligibilityResult {
  const statuses = [input.methodologyStatus, input.templateStatus]

  if (statuses.includes('prohibited')) {
    return { eligible: false, code: 'content.prohibited' }
  }
  if (statuses.includes('expired')) {
    return { eligible: false, code: 'content.expired' }
  }
  if (
    input.contentMode === 'reviewed' &&
    statuses.some((status) => status !== 'reviewed')
  ) {
    return {
      eligible: false,
      code: 'content.development-forbidden-in-production',
    }
  }
  if (statuses.some((status) => status !== 'reviewed' && status !== 'development')) {
    return { eligible: false, code: 'content.prohibited' }
  }

  return { eligible: true }
}
