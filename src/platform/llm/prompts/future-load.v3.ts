import {
  canonicalFutureLoadExplanation,
  DEVELOPMENT_FIXTURE_NOTICE,
} from '../explanation/canonical-prose'
import type { ExplanationFactBundle } from '../explanation/fact-bundle'
import type { ChatMessage } from '../types'

export const FUTURE_LOAD_PROMPT_VERSION = 'future-load.v3'

export function buildFutureLoadMessages(
  bundle: ExplanationFactBundle,
): readonly ChatMessage[] {
  const requiredParagraph = canonicalFutureLoadExplanation(bundle)
  if (!requiredParagraph) {
    throw new Error(
      `No safe explanation template exists for ${bundle.grounding.reasonCode}.`,
    )
  }

  const system = [
    'You reproduce one approved plain-language explanation of a stored strength-training load decision.',
    'You are not a coach and not a clinician.',
    'Return exactly the Required paragraph from the user message, with no prefix, suffix, quotation marks, markdown, or changes.',
    'Do not add advice, diagnoses, medical claims, numbers, or facts.',
    bundle.constraints.developmentFixtureNoticeRequired
      ? `The paragraph must end with exactly: ${DEVELOPMENT_FIXTURE_NOTICE}`
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join(' ')

  const user = [
    'FactBundle JSON:',
    JSON.stringify(bundle),
    'Required paragraph:',
    requiredParagraph,
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}
