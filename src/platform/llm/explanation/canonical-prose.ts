import type { ExplanationFactBundle } from './fact-bundle'

export const DEVELOPMENT_FIXTURE_NOTICE =
  'This is an unreviewed development fixture, not human-reviewed coaching guidance.'

function decisionSentence(bundle: ExplanationFactBundle): string | null {
  const exercise = bundle.display.exerciseName
  const current = bundle.display.currentLoadLabel
  const proposed = bundle.display.proposedLoadLabel

  switch (bundle.grounding.reasonCode) {
    case 'development.adjustment.increase':
      if (bundle.decision.kind !== 'increase') return null
      return `${exercise} future load moves from ${current} to ${proposed} because performed sets met the target at acceptable effort`
    case 'development.adjustment.rpe-above-eight':
      if (bundle.decision.kind !== 'hold') return null
      return `${exercise} stays at ${current} because reported RPE was above the policy threshold`
    case 'development.adjustment.skipped-set':
      if (bundle.decision.kind !== 'hold') return null
      return `${exercise} stays at ${current} because a prescribed set was skipped`
    case 'development.adjustment.missing-data':
      if (bundle.decision.kind !== 'hold') return null
      return `${exercise} stays at ${current} because required session facts were incomplete`
    case 'development.adjustment.target-not-met':
      if (bundle.decision.kind !== 'hold') return null
      return `${exercise} stays at ${current} because target repetitions were not met`
    case 'development.adjustment.load-not-at-target':
      if (bundle.decision.kind !== 'hold') return null
      return `${exercise} stays at ${current} because performed load was not at the prescribed target`
    case 'development.adjustment.increment-exceeds-bound':
      if (bundle.decision.kind !== 'hold') return null
      return `${exercise} stays at ${current} because the candidate increment exceeds the policy bound`
    case 'development.adjustment.pain-block':
      if (bundle.decision.kind !== 'blocked') return null
      return `${exercise} future load is blocked at ${current} because pain was reported`
    default:
      return null
  }
}

/**
 * The model may reproduce only this closed, FactBundle-derived paragraph. Keeping the
 * accepted language finite makes the no-diagnosis/no-advice claim enforceable instead
 * of depending on an incomplete denylist over arbitrary prose.
 */
export function canonicalFutureLoadExplanation(
  bundle: ExplanationFactBundle,
): string | null {
  if (bundle.decision.invalidated) return null
  const sentence = decisionSentence(bundle)
  if (!sentence) return null

  const parts = [
    `${sentence} (reason ${bundle.grounding.reasonCode}, rule ${bundle.grounding.ruleVersion}).`,
  ]
  if (bundle.grounding.reasonCode === 'development.adjustment.pain-block') {
    parts.push('No medical assessment is made.')
  }
  if (bundle.constraints.developmentFixtureNoticeRequired) {
    parts.push(DEVELOPMENT_FIXTURE_NOTICE)
  }
  return parts.join(' ')
}
