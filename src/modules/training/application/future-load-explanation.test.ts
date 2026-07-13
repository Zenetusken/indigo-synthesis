import { describe, expect, it, vi } from 'vitest'
import { explainFutureLoadDecision } from '@/modules/training/application/future-load-explanation'
import type { FutureLoadFactBundlesResult } from '@/modules/training/application/future-load-fact-bundle'
import type { LlmComposition, LlmRuntimeConfig } from '@/platform/llm'
import { FUTURE_LOAD_PROMPT_VERSION } from '@/platform/llm'

const decisionId = 'dec-1'
const sessionId = 'ses-1'
const userId = 'user-1'

function sampleBundleResult(
  overrides: Partial<FutureLoadFactBundlesResult & { status: 'available' }> = {},
): FutureLoadFactBundlesResult {
  return {
    status: 'available',
    buildErrors: [],
    bundles: [
      {
        decision: {
          id: decisionId,
          sessionId,
          exerciseCode: 'development.back-squat',
          exerciseName: 'Back squat — development fixture',
          decision: 'increase',
          currentLoadGrams: 50_000,
          nextLoadGrams: 51_000,
          reasonCode: 'development.adjustment.increase',
          ruleVersion: '0.0.1-development',
          engineVersion: '0.1.0-development',
          methodologyId: 'development.methodology-fixture',
          methodologyVersion: '0.0.1-development',
          methodologyReviewStatus: 'development',
          templateReviewStatus: 'development',
        },
        factBundle: {
          contractVersion: '1',
          bundleKind: 'future-load-decision',
          locale: 'en',
          contentMode: 'development',
          subject: { units: 'metric' },
          decision: {
            decisionId,
            sessionId,
            exerciseCode: 'development.back-squat',
            kind: 'increase',
            currentLoadGrams: 50_000,
            proposedLoadGrams: 51_000,
            invalidated: false,
            invalidationReason: null,
            setFacts: [],
            painReported: false,
          },
          grounding: {
            reasonCode: 'development.adjustment.increase',
            ruleId: 'development.adjustment',
            ruleVersion: '0.0.1-development',
            engineVersion: '0.1.0-development',
            methodologyId: 'development.methodology-fixture',
            methodologyVersion: '0.0.1-development',
          },
          display: {
            currentLoadLabel: '50 kg',
            proposedLoadLabel: '51 kg',
            exerciseName: 'Back squat — development fixture',
          },
          constraints: {
            mustMentionReasonCode: true,
            mustMentionRuleVersion: true,
            mustUseDisplayLoadLabelsOnly: true,
            mustNotInventNumbers: true,
            mustNotDiagnose: true,
            mustNotAdviseIgnoringPainOrHolds: true,
            developmentFixtureNoticeRequired: true,
            maxOutputTokens: 256,
          },
        },
        factBundleHash: 'a'.repeat(64),
      },
    ],
    ...overrides,
  }
}

function disabledConfig(): LlmRuntimeConfig {
  return {
    mode: 'disabled',
    modelId: null,
    modelsDir: 'llm/models',
    weightsDir: 'llm/weights',
    endpointOverride: null,
    timeoutMsOverride: null,
    modelSha256Override: null,
    requireGpu: true,
  }
}

function localConfig(): LlmRuntimeConfig {
  return {
    mode: 'local',
    modelId: 'qwen3.5-9b-q4_k_m',
    modelsDir: 'llm/models',
    weightsDir: 'llm/weights',
    endpointOverride: 'http://127.0.0.1:8080/v1',
    timeoutMsOverride: 8_000,
    modelSha256Override: 'b'.repeat(64),
    requireGpu: true,
  }
}

describe('explainFutureLoadDecision', () => {
  it('returns llm-disabled without synthesizing when mode is disabled', async () => {
    const synthesize = vi.fn()
    const result = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId,
      deps: {
        getBundles: async () => sampleBundleResult(),
        getConfig: disabledConfig,
        compose: () =>
          ({
            config: disabledConfig(),
            registry: null,
            activeSettings: null,
            languageModel: {
              complete: async () => ({
                status: 'unavailable',
                reason: 'disabled',
                detail: null,
              }),
            },
            explanationGenerator: { synthesize },
          }) as unknown as LlmComposition,
        preflight: async () => {
          throw new Error('preflight should not run when disabled')
        },
      },
    })

    expect(result).toMatchObject({ status: 'unavailable', reason: 'llm-disabled' })
    expect(synthesize).not.toHaveBeenCalled()
  })

  it('returns decision-not-found when the decision id is missing', async () => {
    const result = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId: 'missing',
      deps: {
        getBundles: async () => sampleBundleResult(),
        getConfig: disabledConfig,
      },
    })
    expect(result).toMatchObject({ status: 'unavailable', reason: 'decision-not-found' })
  })

  it('returns fact-bundle-failed when the decision failed to build', async () => {
    const result = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId,
      deps: {
        getBundles: async () => ({
          status: 'available',
          bundles: [],
          buildErrors: [
            {
              decisionId,
              exerciseCode: 'development.back-squat',
              message: 'Cannot build without loads',
            },
          ],
        }),
        getConfig: localConfig,
      },
    })
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'fact-bundle-failed',
      detail: 'Cannot build without loads',
    })
  })

  it('returns llm-not-ready when preflight fails', async () => {
    const result = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId,
      deps: {
        getBundles: async () => sampleBundleResult(),
        getConfig: localConfig,
        preflight: async () =>
          ({
            readyForLocalInference: false,
            blockers: ['GPU required but not ready'],
          }) as never,
        compose: () => {
          throw new Error('compose should not run')
        },
      },
    })
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'llm-not-ready',
      detail: 'GPU required but not ready',
    })
  })

  it('returns available inferred prose on successful synthesis', async () => {
    const prose =
      'Load moves from 50 kg to 51 kg (reason development.adjustment.increase, rule 0.0.1-development). This is an unreviewed development fixture, not human-reviewed coaching guidance.'
    const result = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId,
      deps: {
        getBundles: async () => sampleBundleResult(),
        getConfig: localConfig,
        preflight: async () =>
          ({
            readyForLocalInference: true,
            blockers: [],
          }) as never,
        compose: () =>
          ({
            config: localConfig(),
            registry: null,
            activeSettings: { modelId: 'qwen3.5-9b-q4_k_m' },
            languageModel: {
              complete: async () => ({
                status: 'unavailable',
                reason: 'disabled',
                detail: null,
              }),
            },
            explanationGenerator: {
              synthesize: async () => ({
                status: 'available' as const,
                prose,
                modelId: 'qwen3.5-9b-q4_k_m',
                modelContentDigest: 'b'.repeat(64),
                runtimeId: 'fake',
                promptVersion: FUTURE_LOAD_PROMPT_VERSION,
                factBundleHash: 'a'.repeat(64),
                generatedAt: '2026-07-13T00:00:00.000Z',
              }),
            },
          }) as unknown as LlmComposition,
      },
    })

    expect(result).toMatchObject({
      status: 'available',
      inferred: true,
      prose,
      modelId: 'qwen3.5-9b-q4_k_m',
      promptVersion: FUTURE_LOAD_PROMPT_VERSION,
    })
    if (result.status === 'available') {
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('maps synthesis failure without inventing prose', async () => {
    const result = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId,
      deps: {
        getBundles: async () => sampleBundleResult(),
        getConfig: localConfig,
        preflight: async () =>
          ({
            readyForLocalInference: true,
            blockers: [],
          }) as never,
        compose: () =>
          ({
            config: localConfig(),
            registry: null,
            activeSettings: null,
            languageModel: {
              complete: async () => ({
                status: 'unavailable',
                reason: 'disabled',
                detail: null,
              }),
            },
            explanationGenerator: {
              synthesize: async () => ({
                status: 'unavailable' as const,
                reason: 'validation-failed' as const,
                detail: 'Prose contains a number not present in the FactBundle: 110',
              }),
            },
          }) as unknown as LlmComposition,
      },
    })
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'synthesis-failed',
    })
    if (result.status === 'unavailable') {
      expect(result.detail).toMatch(/validation-failed/)
    }
  })
})
