import { canonicalFutureLoadExplanation } from './canonical-prose'
import type { ExplanationFactBundle } from './fact-bundle'

export type ProseValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string }

export const EXPLANATION_VALIDATOR_VERSION = 'future-load-validator.v4'

const diagnosisPatterns: readonly RegExp[] = [
  /\bdiagnos(?:e|is|ed|ing)\b/i,
  /\binjur(?:y|ies|ed)\b/i,
  /\bmedical clearance\b/i,
  /\byou (?:are|have) (?:torn|fractured|ruptured)\b/i,
  /\bovertraining syndrome\b/i,
]

const sentenceInitialActionPattern =
  /(?:^|[.!?]\s+)(?:please\s+)?(?:continue|resume|restart|push|train|lift|exercise|try|attempt|add|increase|decrease|perform|proceed|keep|do)\b/i

// These are unambiguously forward verbs rather than movement nouns such as "push" or
// "lift". Reject them anywhere in a structured label so punctuation, slashes, or Unicode
// dashes cannot turn an authorized exercise name into an imperative clause.
const unambiguousExerciseDirectivePattern =
  /\b(?:continu(?:e|es|ed|ing)|resum(?:e|es|ed|ing)|restart(?:s|ed|ing)?|proceed(?:s|ed|ing)?)\b/i
const exerciseNameClauseDirectivePattern =
  /(?:^|[.!?;:]\s*|[—–/|]\s*)(?:please\s+)?(?:continue|resume|restart|train|try|attempt|add|increase|decrease|perform|proceed|keep|do)\b/i
const unsafeExerciseNameControlPattern = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

/**
 * Explanation is retrospective presentation, never forward coaching. These patterns are
 * deliberately broad: the accepted paragraph does not need modal or imperative advice.
 */
const forwardAdvicePatterns: readonly RegExp[] = [
  /\b(?:should|must|ought|recommend|recommended|suggest|suggested|consider)\b/i,
  /\b(?:best|prudent|advisable|encouraged|urged)\s+to\s+(?:continue|resume|restart|push|train|lift|exercise|try|attempt|add|increase|decrease|perform|proceed|keep|do)\b/i,
  /\b(?:you|the (?:athlete|trainee)|they)\s+(?:can|could|may|might|need to)\b/i,
  sentenceInitialActionPattern,
  /\b(?:safe|okay|ok|fine|cleared)\s+to\s+(?:continue|resume|restart|push|train|lift|exercise|proceed|keep)\b/i,
  /\b(?:ignore|disregard|override|bypass|push through)\b.{0,60}\b(?:pain|hurt|symptom|discomfort|hold|warning)\b/i,
  /\b(?:continu(?:e|ing)|resum(?:e|ing)|restart(?:ing)?|push(?:ing)?|train(?:ing)?|lift(?:ing)?|exercis(?:e|ing)|work(?:ing)?\s+out|proceed(?:ing)?|keep(?:ing)?)\b.{0,60}\b(?:pain|hurt|symptom|discomfort|hold)\b/i,
  /\b(?:pain|hurt|symptom|discomfort|hold)\b.{0,60}\b(?:continu(?:e|ing)|resum(?:e|ing)|restart(?:ing)?|push(?:ing)?|train(?:ing)?|lift(?:ing)?|exercis(?:e|ing)|work(?:ing)?\s+out|proceed(?:ing)?|keep(?:ing)?)\b/i,
]

const exerciseNameAdvicePatterns: readonly RegExp[] = [
  ...forwardAdvicePatterns.filter((pattern) => pattern !== sentenceInitialActionPattern),
  unambiguousExerciseDirectivePattern,
  exerciseNameClauseDirectivePattern,
  /(?:^|[.!?;:]\s*|[—–/|]\s*)please\s+(?:push|lift|exercise)\b/i,
  /\b(?:safely|carefully|hard(?:er)?|yourself|now)\b/i,
]

const maxProseLength = 2_000

function normalize(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ')
}

function replaceAllLiteral(text: string, literal: string): string {
  return literal ? text.split(literal).join(' ') : text
}

function validateExerciseNameSafety(
  bundle: ExplanationFactBundle,
): ProseValidationResult {
  if (unsafeExerciseNameControlPattern.test(bundle.display.exerciseName)) {
    return {
      ok: false,
      detail: 'Exercise name contains prohibited control or line-separator characters.',
    }
  }
  const exerciseName = normalize(bundle.display.exerciseName).trim()
  if (!exerciseName) {
    return { ok: false, detail: 'Exercise name is empty.' }
  }
  for (const pattern of diagnosisPatterns) {
    if (pattern.test(exerciseName)) {
      return {
        ok: false,
        detail: 'Exercise name contains prohibited diagnostic language.',
      }
    }
  }
  for (const pattern of exerciseNameAdvicePatterns) {
    if (pattern.test(exerciseName)) {
      return {
        ok: false,
        detail: 'Exercise name contains prohibited advice or safety-bypass language.',
      }
    }
  }
  return { ok: true }
}

const loadMentionPattern =
  /(?<![\p{L}\p{N}])\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*(?:kg|kilograms?|lb|lbs|pounds?)(?![\p{L}\p{N}])/giu

function validateNumericContexts(
  normalized: string,
  bundle: ExplanationFactBundle,
): ProseValidationResult {
  // The exact structured name is an authorized identity field. Mask it before every
  // numeric scan so names such as "25 kg Plate Carry" cannot be mistaken for an invented
  // working load. Closed-template byte equality later prevents extra name repetitions.
  const exerciseNameMasked = replaceAllLiteral(
    normalized,
    normalize(bundle.display.exerciseName),
  )
  const authorizedLoadLabels = new Set(
    [bundle.display.currentLoadLabel, bundle.display.proposedLoadLabel].map(normalize),
  )

  for (const mention of exerciseNameMasked.match(loadMentionPattern) ?? []) {
    if (!authorizedLoadLabels.has(mention)) {
      return {
        ok: false,
        detail: `Prose contains an unauthorized display load: ${mention}`,
      }
    }
  }

  // Numbers are permitted only inside exact required identity strings or exact display
  // labels. Repetitions, RPE, ordinals, and raw grams do not authorize prose.
  let unmasked = exerciseNameMasked
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

  const exerciseNameSafety = validateExerciseNameSafety(bundle)
  if (!exerciseNameSafety.ok) return exerciseNameSafety

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

  // The canonical paragraph places the exact structured exercise label beside fixed
  // prose. Scan that label independently above, then mask it here so legitimate labels
  // such as "Push Press" or "Olympic Lift" cannot form cross-boundary advice matches.
  const policyText = replaceAllLiteral(normalized, normalize(bundle.display.exerciseName))
  for (const pattern of diagnosisPatterns) {
    if (pattern.test(policyText)) {
      return { ok: false, detail: 'Prose contains prohibited diagnostic language.' }
    }
  }

  for (const pattern of forwardAdvicePatterns) {
    if (pattern.test(policyText)) {
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
