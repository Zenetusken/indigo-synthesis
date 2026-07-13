import { canonicalFutureLoadExplanation } from './canonical-prose'
import type { ExplanationFactBundle } from './fact-bundle'

export type ProseValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string }

export const EXPLANATION_VALIDATOR_VERSION = 'future-load-validator.v3'

const diagnosisPatterns: readonly RegExp[] = [
  /\bdiagnos(?:e|is|ed|ing)\b/i,
  /\binjur(?:y|ies|ed)\b/i,
  /\bmedical clearance\b/i,
  /\byou (?:are|have) (?:torn|fractured|ruptured)\b/i,
  /\bovertraining syndrome\b/i,
]

/**
 * Explanation is retrospective presentation, never forward coaching. These patterns are
 * deliberately broad: the accepted paragraph does not need modal or imperative advice.
 */
const forwardAdvicePatterns: readonly RegExp[] = [
  /\b(?:should|must|ought|recommend|recommended|suggest|suggested|consider)\b/i,
  /\b(?:best|prudent|advisable|encouraged|urged)\s+to\s+(?:continue|resume|restart|push|train|lift|exercise|try|attempt|add|increase|decrease|perform|proceed|keep|do)\b/i,
  /\b(?:you|the (?:athlete|trainee)|they)\s+(?:can|could|may|might|need to)\b/i,
  /(?:^|[.!?]\s+)(?:please\s+)?(?:continue|resume|restart|push|train|lift|exercise|try|attempt|add|increase|decrease|perform|proceed|keep|do)\b/i,
  /\b(?:safe|okay|ok|fine|cleared)\s+to\s+(?:continue|resume|restart|push|train|lift|exercise|proceed|keep)\b/i,
  /\b(?:ignore|disregard|override|bypass|push through)\b.{0,60}\b(?:pain|hurt|symptom|discomfort|hold|warning)\b/i,
  /\b(?:continu(?:e|ing)|resum(?:e|ing)|restart(?:ing)?|push(?:ing)?|train(?:ing)?|lift(?:ing)?|exercis(?:e|ing)|work(?:ing)?\s+out|proceed(?:ing)?|keep(?:ing)?)\b.{0,60}\b(?:pain|hurt|symptom|discomfort|hold)\b/i,
  /\b(?:pain|hurt|symptom|discomfort|hold)\b.{0,60}\b(?:continu(?:e|ing)|resum(?:e|ing)|restart(?:ing)?|push(?:ing)?|train(?:ing)?|lift(?:ing)?|exercis(?:e|ing)|work(?:ing)?\s+out|proceed(?:ing)?|keep(?:ing)?)\b/i,
]

const maxProseLength = 2_000

function normalize(text: string): string {
  return text.normalize('NFKC')
}

function replaceAllLiteral(text: string, literal: string): string {
  return literal ? text.split(literal).join(' ') : text
}

const loadMentionPattern =
  /(?<![\p{L}\p{N}])\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*(?:kg|kilograms?|lb|lbs|pounds?)(?![\p{L}\p{N}])/giu

function validateNumericContexts(
  normalized: string,
  bundle: ExplanationFactBundle,
): ProseValidationResult {
  const authorizedLoadLabels = new Set(
    [bundle.display.currentLoadLabel, bundle.display.proposedLoadLabel].map(normalize),
  )

  for (const mention of normalized.match(loadMentionPattern) ?? []) {
    if (!authorizedLoadLabels.has(mention)) {
      return {
        ok: false,
        detail: `Prose contains an unauthorized display load: ${mention}`,
      }
    }
  }

  // V2 intentionally permits numbers only inside exact required identity strings or exact
  // display labels. Repetitions, RPE, ordinals, and raw grams do not authorize prose.
  let unmasked = normalized
  for (const literal of [
    bundle.display.currentLoadLabel,
    bundle.display.proposedLoadLabel,
    bundle.grounding.reasonCode,
    bundle.grounding.ruleVersion,
  ]) {
    unmasked = replaceAllLiteral(unmasked, normalize(literal))
  }

  const numberWord = unmasked.match(
    /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|half|quarter|double|twice)\b/i,
  )?.[0]
  if (numberWord) {
    return {
      ok: false,
      detail: `Prose contains a number word outside an authorized field: ${numberWord}`,
    }
  }

  const remainingNumber = unmasked.match(/\p{N}+/u)?.[0]
  if (remainingNumber) {
    return {
      ok: false,
      detail: `Prose contains a number outside an authorized field: ${remainingNumber}`,
    }
  }

  return { ok: true }
}

export function validateExplanationProse(
  prose: string,
  bundle: ExplanationFactBundle,
): ProseValidationResult {
  const trimmed = prose.trim()
  if (!trimmed) {
    return { ok: false, detail: 'Prose is empty.' }
  }
  if (trimmed.length > maxProseLength) {
    return { ok: false, detail: 'Prose exceeds maximum length.' }
  }

  if (bundle.decision.invalidated) {
    return {
      ok: false,
      detail: 'Invalidated decisions must not receive active-decision prose.',
    }
  }

  const normalized = normalize(trimmed)
  const reasonCode = bundle.grounding.reasonCode
  const ruleVersion = bundle.grounding.ruleVersion

  if (!normalized.includes(reasonCode)) {
    return { ok: false, detail: `Prose must include reason code ${reasonCode}.` }
  }
  if (!normalized.includes(ruleVersion)) {
    return { ok: false, detail: `Prose must include rule version ${ruleVersion}.` }
  }

  const kind = bundle.decision.kind
  if (kind === 'increase') {
    if (!normalized.includes(bundle.display.currentLoadLabel)) {
      return {
        ok: false,
        detail: `Prose must include current load label ${bundle.display.currentLoadLabel}.`,
      }
    }
    if (!normalized.includes(bundle.display.proposedLoadLabel)) {
      return {
        ok: false,
        detail: `Prose must include proposed load label ${bundle.display.proposedLoadLabel}.`,
      }
    }
  }

  if (
    (kind === 'blocked' || kind === 'hold') &&
    bundle.decision.currentLoadGrams === bundle.decision.proposedLoadGrams
  ) {
    // Must not claim a new working weight different from the current label.
    const proposed = bundle.display.proposedLoadLabel
    const current = bundle.display.currentLoadLabel
    if (
      proposed !== current &&
      normalized.includes(proposed) &&
      !normalized.includes(current)
    ) {
      return {
        ok: false,
        detail: 'Hold/blocked prose must not present a replacement working weight alone.',
      }
    }
  }

  for (const pattern of diagnosisPatterns) {
    if (pattern.test(normalized)) {
      return { ok: false, detail: 'Prose contains prohibited diagnostic language.' }
    }
  }

  for (const pattern of forwardAdvicePatterns) {
    if (pattern.test(normalized)) {
      return {
        ok: false,
        detail: 'Prose contains prohibited forward advice or safety-bypass language.',
      }
    }
  }

  const numericValidation = validateNumericContexts(normalized, bundle)
  if (!numericValidation.ok) return numericValidation

  const canonical = canonicalFutureLoadExplanation(bundle)
  if (!canonical || trimmed !== canonical) {
    return {
      ok: false,
      detail: 'Prose differs from the closed FactBundle-derived explanation template.',
    }
  }

  return { ok: true }
}
