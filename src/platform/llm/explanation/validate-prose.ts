import type { ExplanationFactBundle } from './fact-bundle'

export type ProseValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string }

const diagnosisPatterns: readonly RegExp[] = [
  /\bdiagnos(?:e|is|ed|ing)\b/i,
  /\binjur(?:y|ies|ed)\b/i,
  /\bmedical clearance\b/i,
  /\bsafe to push through (?:the )?pain\b/i,
  /\byou (?:are|have) (?:torn|fractured|ruptured)\b/i,
  /\bovertraining syndrome\b/i,
]

const maxProseLength = 2_000

function normalize(text: string): string {
  return text.normalize('NFKC')
}

/**
 * Extract load-like number tokens (integers or decimals) for smuggling checks.
 * Ignores pure ordinal-looking sequences already handled via allow-list comparison.
 */
function extractNumericTokens(text: string): readonly string[] {
  const matches = text.match(/\d+(?:\.\d+)?/g)
  return matches ?? []
}

function allowListedNumbers(bundle: ExplanationFactBundle): Set<string> {
  const allowed = new Set<string>()

  const add = (value: string | number | null | undefined) => {
    if (value === null || value === undefined) return
    const asString = String(value)
    allowed.add(asString)
    // Also accept integer grams forms when display labels embed them.
    if (typeof value === 'number' && Number.isFinite(value)) {
      allowed.add(String(value))
    }
  }

  add(bundle.display.currentLoadLabel)
  add(bundle.display.proposedLoadLabel)
  // Pull numeric substrings from display labels (e.g. "100 kg", "102.5 kg").
  for (const label of [
    bundle.display.currentLoadLabel,
    bundle.display.proposedLoadLabel,
  ]) {
    for (const token of extractNumericTokens(label)) {
      allowed.add(token)
    }
  }

  add(bundle.decision.currentLoadGrams)
  add(bundle.decision.proposedLoadGrams)
  for (const set of bundle.decision.setFacts) {
    add(set.ordinal)
    add(set.loadGrams)
    add(set.repetitions)
    add(set.rpe)
  }

  // Rule version often contains dotted numbers (0.0.1) — allow those tokens.
  for (const token of extractNumericTokens(bundle.grounding.ruleVersion)) {
    allowed.add(token)
  }
  for (const token of extractNumericTokens(bundle.grounding.engineVersion)) {
    allowed.add(token)
  }
  for (const token of extractNumericTokens(bundle.grounding.methodologyVersion)) {
    allowed.add(token)
  }

  return allowed
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

  const allowed = allowListedNumbers(bundle)
  for (const token of extractNumericTokens(normalized)) {
    if (!allowed.has(token)) {
      return {
        ok: false,
        detail: `Prose contains a number not present in the FactBundle: ${token}`,
      }
    }
  }

  if (bundle.constraints.developmentFixtureNoticeRequired) {
    if (!/unreviewed|development fixture|not human-reviewed/i.test(normalized)) {
      return {
        ok: false,
        detail: 'Development content prose must include an unreviewed-fixture notice.',
      }
    }
  }

  return { ok: true }
}
