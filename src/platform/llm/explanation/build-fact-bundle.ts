import type { ExplanationFactBundle } from './fact-bundle'

/**
 * Persisted future-load decision fields as stored/returned by the training application.
 * Display labels must be pre-formatted by the caller (e.g. formatLoad) so platform code
 * does not import product modules.
 */
export type PersistedFutureLoadDecision = {
  readonly decisionId: string
  readonly sessionId: string
  readonly exerciseCode: string
  readonly exerciseName: string
  /** Database decision kind: blocked methodology outcomes are stored as unavailable. */
  readonly decision: 'increase' | 'hold' | 'unavailable'
  readonly currentLoadGrams: number | null
  readonly nextLoadGrams: number | null
  readonly reasonCode: string
  readonly ruleVersion: string
  readonly currentLoadLabel: string
  readonly proposedLoadLabel: string
  readonly units: 'metric' | 'imperial'
  readonly contentMode: 'development' | 'reviewed'
  readonly engineVersion: string
  readonly methodologyId: string
  readonly methodologyVersion: string
  readonly ruleId?: string
  readonly painReported?: boolean | null
  readonly invalidated?: boolean
  readonly invalidationReason?: string | null
  readonly setFacts?: ExplanationFactBundle['decision']['setFacts']
}

export class FactBundleBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FactBundleBuildError'
  }
}

function mapDecisionKind(
  decision: PersistedFutureLoadDecision['decision'],
): ExplanationFactBundle['decision']['kind'] {
  if (decision === 'increase') return 'increase'
  if (decision === 'hold') return 'hold'
  return 'blocked'
}

/**
 * Builds a contract FactBundle from persisted decision fields without inventing loads.
 * Grams that are null become 0 only when both current and next are null would be invalid—
 * null loads fail closed instead.
 */
export function buildFutureLoadFactBundle(
  source: PersistedFutureLoadDecision,
): ExplanationFactBundle {
  if (!source.decisionId || !source.sessionId || !source.exerciseCode) {
    throw new FactBundleBuildError(
      'decisionId, sessionId, and exerciseCode are required.',
    )
  }
  if (source.currentLoadGrams === null || source.nextLoadGrams === null) {
    throw new FactBundleBuildError(
      'Cannot build a FactBundle without concrete current and next load grams.',
    )
  }
  if (!source.reasonCode || !source.ruleVersion) {
    throw new FactBundleBuildError('reasonCode and ruleVersion are required.')
  }
  if (!source.currentLoadLabel || !source.proposedLoadLabel) {
    throw new FactBundleBuildError(
      'Display load labels are required (format before build).',
    )
  }

  const kind = mapDecisionKind(source.decision)
  const invalidated = source.invalidated === true

  return {
    contractVersion: '1',
    bundleKind: 'future-load-decision',
    locale: 'en',
    contentMode: source.contentMode,
    subject: { units: source.units },
    decision: {
      decisionId: source.decisionId,
      sessionId: source.sessionId,
      exerciseCode: source.exerciseCode,
      kind,
      currentLoadGrams: source.currentLoadGrams,
      proposedLoadGrams: source.nextLoadGrams,
      invalidated,
      invalidationReason: source.invalidationReason ?? null,
      setFacts: source.setFacts ?? [],
      painReported: source.painReported ?? null,
    },
    grounding: {
      reasonCode: source.reasonCode,
      ruleId:
        source.ruleId ??
        (source.reasonCode.split('.').slice(0, -1).join('.') || source.reasonCode),
      ruleVersion: source.ruleVersion,
      engineVersion: source.engineVersion,
      methodologyId: source.methodologyId,
      methodologyVersion: source.methodologyVersion,
    },
    display: {
      currentLoadLabel: source.currentLoadLabel,
      proposedLoadLabel: source.proposedLoadLabel,
      exerciseName: source.exerciseName,
    },
    constraints: {
      mustMentionReasonCode: true,
      mustMentionRuleVersion: true,
      mustUseDisplayLoadLabelsOnly: true,
      mustNotInventNumbers: true,
      mustNotDiagnose: true,
      mustNotAdviseIgnoringPainOrHolds: true,
      developmentFixtureNoticeRequired: source.contentMode === 'development',
      maxOutputTokens: 256,
    },
  }
}
