import type { ExplanationFactBundle } from '../explanation/fact-bundle'
import type { ChatMessage } from '../types'

export const FUTURE_LOAD_PROMPT_VERSION = 'future-load.v1'

export function buildFutureLoadMessages(
  bundle: ExplanationFactBundle,
): readonly ChatMessage[] {
  const developmentNotice = bundle.constraints.developmentFixtureNoticeRequired
    ? ' Include a short notice that this is an unreviewed development fixture and not human-reviewed coaching guidance.'
    : ''

  const system = [
    'You write plain-language explanations of strength-training load decisions.',
    'You are a copywriter over closed facts, not a coach and not a clinician.',
    'Use ONLY the facts in the user message FactBundle.',
    'Do not invent loads, reps, RPE, dates, diagnoses, or medical advice.',
    'Do not tell the athlete to ignore pain or safety holds.',
    'Do not call deterministic rules AI, smart, or optimized.',
    'You must mention the exact reasonCode and ruleVersion strings from grounding.',
    'When kind is increase, include the exact display.currentLoadLabel and display.proposedLoadLabel strings.',
    'Keep the answer to a short paragraph (a few sentences).',
    developmentNotice,
  ]
    .filter(Boolean)
    .join(' ')

  const user = [
    'Explain this future-load decision for the trainee.',
    'FactBundle JSON:',
    JSON.stringify(bundle),
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}
