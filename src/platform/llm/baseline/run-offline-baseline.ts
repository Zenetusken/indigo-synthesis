import { resolve } from 'node:path'
import { createDisabledLanguageModel } from '../adapters/disabled'
import { createFakeLanguageModel } from '../adapters/fake'
import { parseLlmConfig } from '../config'
import { canonicalFutureLoadExplanation } from '../explanation/canonical-prose'
import { createExplanationGenerationPort } from '../explanation/synthesize'
import { validateExplanationProse } from '../explanation/validate-prose'
import { loadModelRegistry } from '../model-registry'
import { FUTURE_LOAD_PROMPT_VERSION } from '../prompts/future-load.v3'
import {
  EXERCISE_NAME_REJECTION_TRAPS,
  GOLDEN_BASELINE_CASES,
  type GoldenBaselineCase,
  LLM_BASELINE_VERSION,
} from './golden-cases'

export type BaselineCheckResult = {
  readonly id: string
  readonly ok: boolean
  readonly detail: string
}

export type OfflineBaselineReport = {
  readonly baselineVersion: string
  readonly promptVersion: string
  readonly checkedAt: string
  readonly modelPackIds: readonly string[]
  readonly checks: readonly BaselineCheckResult[]
  readonly passed: number
  readonly failed: number
  readonly ok: boolean
}

function check(id: string, ok: boolean, detail: string): BaselineCheckResult {
  return { id, ok, detail }
}

function runValidationMatrix(
  cases: readonly GoldenBaselineCase[],
): BaselineCheckResult[] {
  const results: BaselineCheckResult[] = []

  for (const golden of cases) {
    const accepted = validateExplanationProse(golden.acceptedProse, golden.factBundle)
    if (golden.id === 'invalidated-decision') {
      results.push(
        check(
          `${golden.id}/accepted-must-fail`,
          !accepted.ok,
          accepted.ok
            ? 'Invalidated decision prose incorrectly passed validation'
            : 'Invalidated decision correctly rejected',
        ),
      )
    } else {
      results.push(
        check(
          `${golden.id}/accepted`,
          accepted.ok,
          accepted.ok
            ? 'Accepted template passed validation'
            : `Accepted template failed: ${'detail' in accepted ? accepted.detail : 'unknown'}`,
        ),
      )
    }

    for (const rejected of golden.rejectedProse) {
      const result = validateExplanationProse(rejected.prose, golden.factBundle)
      results.push(
        check(
          `${golden.id}/reject:${rejected.label}`,
          !result.ok,
          result.ok
            ? `Expected rejection for ${rejected.label} but validation passed`
            : `Correctly rejected ${rejected.label}`,
        ),
      )
    }
  }

  return results
}

function runExerciseNameRejectionMatrix(): BaselineCheckResult[] {
  const source = GOLDEN_BASELINE_CASES.find(
    (golden) => golden.id === 'increase-at-target',
  )
  if (!source) {
    return [
      check(
        'exercise-name/reject:fixture-missing',
        false,
        'Missing increase fixture for structured exercise-name rejection traps',
      ),
    ]
  }

  return EXERCISE_NAME_REJECTION_TRAPS.map((trap) => {
    const factBundle = {
      ...source.factBundle,
      display: { ...source.factBundle.display, exerciseName: trap.exerciseName },
    }
    const canonical = canonicalFutureLoadExplanation(factBundle)
    const result = canonical
      ? validateExplanationProse(canonical, factBundle)
      : { ok: false as const, detail: 'No canonical paragraph was derived' }
    return check(
      `exercise-name/reject:${trap.label}`,
      !result.ok,
      result.ok
        ? `Unsafe structured exercise name passed: ${trap.exerciseName}`
        : `Correctly rejected structured exercise-name trap ${trap.label}`,
    )
  })
}

async function runSynthesizeMatrix(
  cases: readonly GoldenBaselineCase[],
  modelId: string,
): Promise<BaselineCheckResult[]> {
  const results: BaselineCheckResult[] = []
  const registry = loadModelRegistry(resolve(process.cwd(), 'llm/models'))
  const settings = registry.get(modelId)
  if (!settings) {
    return [check('synthesize/settings', false, `Missing model pack ${modelId}`)]
  }

  for (const golden of cases) {
    if (golden.id === 'invalidated-decision') {
      const port = createExplanationGenerationPort({
        languageModel: createFakeLanguageModel(async () => ({
          status: 'available',
          text: golden.acceptedProse,
          modelId: settings.modelId,
          modelContentDigest: 'baseline-fake',
          runtimeId: 'fake',
        })),
        modelSettings: settings,
        modelContentDigest: 'baseline-fake',
        now: () => new Date('2026-07-12T00:00:00.000Z'),
      })
      const result = await port.synthesize({
        factBundle: golden.factBundle,
        promptVersion: FUTURE_LOAD_PROMPT_VERSION,
        timeoutMs: 1000,
      })
      results.push(
        check(
          `${golden.id}/synthesize-unavailable`,
          result.status === 'unavailable' && result.reason === 'invalidated-decision',
          result.status === 'unavailable'
            ? `Correct unavailable reason=${result.reason}`
            : 'Expected unavailable for invalidated decision',
        ),
      )
      continue
    }

    const port = createExplanationGenerationPort({
      languageModel: createFakeLanguageModel(async () => ({
        status: 'available',
        text: golden.acceptedProse,
        modelId: settings.modelId,
        modelContentDigest: 'baseline-fake',
        runtimeId: 'fake',
      })),
      modelSettings: settings,
      modelContentDigest: 'baseline-fake',
      now: () => new Date('2026-07-12T00:00:00.000Z'),
    })
    const result = await port.synthesize({
      factBundle: golden.factBundle,
      promptVersion: FUTURE_LOAD_PROMPT_VERSION,
      timeoutMs: 1000,
    })
    results.push(
      check(
        `${golden.id}/synthesize-available`,
        result.status === 'available',
        result.status === 'available'
          ? 'Fake model + accepted template synthesized'
          : `Expected available, got ${result.status}${result.status === 'unavailable' ? ` (${result.reason}: ${result.detail})` : ''}`,
      ),
    )
  }

  return results
}

/**
 * Offline calibrated baseline: registry load, validation matrix, fake synthesize path,
 * and disabled composition. Does not require weights or a running inference server.
 */
export async function runOfflineBaseline(options?: {
  readonly modelsDir?: string
  readonly now?: () => Date
}): Promise<OfflineBaselineReport> {
  const checks: BaselineCheckResult[] = []
  const modelsDir = options?.modelsDir ?? resolve(process.cwd(), 'llm/models')
  const now = options?.now ?? (() => new Date())

  try {
    const registry = loadModelRegistry(modelsDir)
    const ids = [...registry.keys()].sort()
    checks.push(
      check(
        'registry/load',
        ids.length === 1 && ids[0] === 'qwen3.5-9b-q4_k_m',
        `Loaded packs: ${ids.join(', ')}`,
      ),
    )

    const activeCases = GOLDEN_BASELINE_CASES.filter(
      (golden) => golden.id !== 'invalidated-decision',
    )
    const rejectTrapCount = GOLDEN_BASELINE_CASES.reduce<number>(
      (total, golden) => total + golden.rejectedProse.length,
      EXERCISE_NAME_REJECTION_TRAPS.length,
    )
    checks.push(
      check(
        'coverage/non-empty-validation-matrices',
        activeCases.length > 0 && rejectTrapCount > 0,
        `${activeCases.length} active accepted case(s); ${rejectTrapCount} rejection trap(s)`,
      ),
    )

    checks.push(...runValidationMatrix(GOLDEN_BASELINE_CASES))
    checks.push(...runExerciseNameRejectionMatrix())
    checks.push(
      ...(await runSynthesizeMatrix(GOLDEN_BASELINE_CASES, 'qwen3.5-9b-q4_k_m')),
    )

    const disabled = createDisabledLanguageModel()
    const disabledResult = await disabled.complete({
      messages: [{ role: 'user', content: 'ping' }],
      sampling: {
        temperature: 0.3,
        topP: 0.8,
        topK: 20,
        minP: 0,
        presencePenalty: 0,
        repetitionPenalty: 1,
        maxTokens: 16,
      },
      timeoutMs: 100,
      servedModelName: 'n/a',
      enableThinking: false,
      modelId: 'n/a',
      modelContentDigest: 'disabled-no-model',
    })
    checks.push(
      check(
        'composition/disabled-default',
        disabledResult.status === 'unavailable' && disabledResult.reason === 'disabled',
        'Disabled adapter returns unavailable/disabled',
      ),
    )

    const defaultConfig = parseLlmConfig({})
    checks.push(
      check(
        'config/default-disabled',
        defaultConfig.mode === 'disabled',
        `Default mode=${defaultConfig.mode}`,
      ),
    )

    const passed = checks.filter((c) => c.ok).length
    const failed = checks.length - passed

    return {
      baselineVersion: LLM_BASELINE_VERSION,
      promptVersion: FUTURE_LOAD_PROMPT_VERSION,
      checkedAt: now().toISOString(),
      modelPackIds: ids,
      checks,
      passed,
      failed,
      ok: failed === 0,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const failedCheck = check('baseline/fatal', false, detail)
    return {
      baselineVersion: LLM_BASELINE_VERSION,
      promptVersion: FUTURE_LOAD_PROMPT_VERSION,
      checkedAt: now().toISOString(),
      modelPackIds: [],
      checks: [failedCheck],
      passed: 0,
      failed: 1,
      ok: false,
    }
  }
}

export function formatOfflineBaselineReport(report: OfflineBaselineReport): string {
  const lines = [
    `LLM offline baseline ${report.baselineVersion}`,
    `promptVersion=${report.promptVersion}`,
    `checkedAt=${report.checkedAt}`,
    `packs=${report.modelPackIds.join(',') || '(none)'}`,
    `result=${report.ok ? 'PASS' : 'FAIL'} (${report.passed} passed, ${report.failed} failed)`,
    '',
  ]
  for (const item of report.checks) {
    lines.push(`${item.ok ? 'OK' : 'FAIL'}  ${item.id} — ${item.detail}`)
  }
  return lines.join('\n')
}
