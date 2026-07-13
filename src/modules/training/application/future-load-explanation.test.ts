import { describe, expect, it, vi } from 'vitest'
import { explainFutureLoadDecision } from '@/modules/training/application/future-load-explanation'
import { createMemoryFutureLoadExplanationCache } from '@/modules/training/application/future-load-explanation-cache'
import { createBoundedAsyncSingleFlight } from '@/modules/training/application/future-load-explanation-singleflight'
import type { FutureLoadFactBundlesResult } from '@/modules/training/application/future-load-fact-bundle'
import type { LlmComposition, LlmRuntimeConfig } from '@/platform/llm'
import {
  canonicalFutureLoadExplanation,
  EXPLANATION_VALIDATOR_VERSION,
  explanationCacheKey,
  FUTURE_LOAD_PROMPT_VERSION,
} from '@/platform/llm'

const decisionId = 'dec-1'
const sessionId = 'ses-1'
const userId = 'user-1'
const modelDigest = '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8'
const verifiedRuntimeIdentity = {
  modelId: 'qwen3.5-9b-q4_k_m',
  modelContentDigest: modelDigest,
  servedModelName: 'qwen3.5-9b-q4_k_m',
  runtimeId: 'llama.cpp@test',
  runtimeAttestationDigest: 'c'.repeat(64),
} as const

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

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
          invalidatedAt: null,
          invalidationCorrectionId: null,
          invalidationCorrectionKind: null,
          invalidationReason: null,
        },
        factBundle: {
          contractVersion: '2',
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

function sampleValidProse(): string {
  const result = sampleBundleResult()
  if (result.status !== 'available') throw new Error('sample bundle unavailable')
  const bundle = result.bundles[0]?.factBundle
  if (!bundle) throw new Error('sample bundle missing')
  const prose = canonicalFutureLoadExplanation(bundle)
  if (!prose) throw new Error('sample bundle has no safe explanation')
  return prose
}

function disabledConfig(): LlmRuntimeConfig {
  return {
    mode: 'disabled',
    modelId: null,
    modelsDir: 'llm/models',
    weightsDir: 'llm/weights',
    runtimeAttestationPath: 'tmp/llm-runtime-attestation.json',
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
    runtimeAttestationPath: 'tmp/llm-runtime-attestation.json',
    endpointOverride: 'http://127.0.0.1:8080/v1',
    timeoutMsOverride: 3_000,
    modelSha256Override: modelDigest,
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
        cache: createMemoryFutureLoadExplanationCache(),
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

  it('fails soft when local model configuration cannot be parsed', async () => {
    const result = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId,
      deps: {
        cache: createMemoryFutureLoadExplanationCache(),
        getBundles: async () => sampleBundleResult(),
        getConfig: () => {
          throw new Error('malformed operator environment')
        },
      },
    })

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'llm-not-ready',
      detail: expect.stringContaining('configuration is invalid'),
    })
  })

  it('returns decision-not-found when the decision id is missing', async () => {
    const result = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId: 'missing',
      deps: {
        cache: createMemoryFutureLoadExplanationCache(),
        getBundles: async () => sampleBundleResult(),
        getConfig: disabledConfig,
      },
    })
    expect(result).toMatchObject({ status: 'unavailable', reason: 'decision-not-found' })
  })

  it('reports ineligible content distinctly from a missing decision', async () => {
    const result = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId,
      deps: {
        cache: createMemoryFutureLoadExplanationCache(),
        getBundles: async () => ({ status: 'unavailable', reason: 'ineligible' }),
        getConfig: disabledConfig,
      },
    })

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'content-ineligible',
      detail: expect.stringContaining('ineligible'),
    })
  })

  it('returns fact-bundle-failed when the decision failed to build', async () => {
    const result = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId,
      deps: {
        cache: createMemoryFutureLoadExplanationCache(),
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

  it('returns llm-not-ready when preflight fails on a cache miss', async () => {
    const result = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId,
      deps: {
        cache: createMemoryFutureLoadExplanationCache(),
        getBundles: async () => sampleBundleResult(),
        getConfig: localConfig,
        preflight: async () =>
          ({
            readyForLocalInference: false,
            blockers: ['GPU required but not ready'],
          }) as never,
        compose: () =>
          ({
            config: localConfig(),
            registry: null,
            activeSettings: {
              modelId: 'qwen3.5-9b-q4_k_m',
              artifacts: { expectedSha256: modelDigest },
            },
            languageModel: {
              complete: async () => ({
                status: 'unavailable',
                reason: 'disabled',
                detail: null,
              }),
            },
            explanationGenerator: {
              synthesize: async () => {
                throw new Error('should not synthesize')
              },
            },
          }) as unknown as LlmComposition,
      },
    })
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'llm-not-ready',
      detail: 'GPU required but not ready',
    })
  })

  it('fails soft when runtime preflight throws on a cache miss', async () => {
    const result = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId,
      deps: {
        cache: createMemoryFutureLoadExplanationCache(),
        getBundles: async () => sampleBundleResult(),
        getConfig: localConfig,
        preflight: async () => {
          throw new Error('runtime probe failed unexpectedly')
        },
      },
    })

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'llm-not-ready',
      detail: expect.stringContaining('readiness could not be verified'),
    })
  })

  it('returns available inferred prose on successful synthesis', async () => {
    const prose = sampleValidProse()
    const result = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId,
      deps: {
        cache: createMemoryFutureLoadExplanationCache(),
        getBundles: async () => sampleBundleResult(),
        getConfig: localConfig,
        preflight: async () =>
          ({
            readyForLocalInference: true,
            blockers: [],
            verifiedRuntimeIdentity,
          }) as never,
        compose: () =>
          ({
            config: localConfig(),
            registry: null,
            activeSettings: {
              modelId: 'qwen3.5-9b-q4_k_m',
              artifacts: { expectedSha256: modelDigest },
            },
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
                modelContentDigest: modelDigest,
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
      fromCache: false,
    })
    if (result.status === 'available') {
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('serves a second request from cache without synthesizing again', async () => {
    const prose = sampleValidProse()
    const synthesize = vi.fn(async () => ({
      status: 'available' as const,
      prose,
      modelId: 'qwen3.5-9b-q4_k_m',
      modelContentDigest: modelDigest,
      runtimeId: 'fake',
      promptVersion: FUTURE_LOAD_PROMPT_VERSION,
      factBundleHash: 'a'.repeat(64),
      generatedAt: '2026-07-13T00:00:00.000Z',
    }))
    const preflight = vi.fn(async () => ({
      readyForLocalInference: true,
      blockers: [],
      verifiedRuntimeIdentity,
    }))
    const cache = createMemoryFutureLoadExplanationCache()
    const deps = {
      cache,
      getBundles: async () => sampleBundleResult(),
      getConfig: localConfig,
      preflight: preflight as never,
      compose: () =>
        ({
          config: localConfig(),
          registry: null,
          activeSettings: {
            modelId: 'qwen3.5-9b-q4_k_m',
            artifacts: { expectedSha256: modelDigest },
          },
          languageModel: {
            complete: async () => ({
              status: 'unavailable',
              reason: 'disabled',
              detail: null,
            }),
          },
          explanationGenerator: { synthesize },
        }) as unknown as LlmComposition,
    }

    const first = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId,
      deps,
    })
    const second = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId,
      deps,
    })

    expect(first).toMatchObject({ status: 'available', fromCache: false, prose })
    expect(second).toMatchObject({ status: 'available', fromCache: true, prose })
    expect(synthesize).toHaveBeenCalledTimes(1)
    expect(preflight).toHaveBeenCalledTimes(1)
  })

  it('rejects and repairs invalid cached prose under the current validator', async () => {
    const validProse = sampleValidProse()
    const synthesize = vi.fn(async () => ({
      status: 'available' as const,
      prose: validProse,
      modelId: verifiedRuntimeIdentity.modelId,
      modelContentDigest: modelDigest,
      runtimeId: verifiedRuntimeIdentity.runtimeId,
      promptVersion: FUTURE_LOAD_PROMPT_VERSION,
      factBundleHash: 'a'.repeat(64),
      generatedAt: '2026-07-13T00:00:00.000Z',
    }))
    const cache = createMemoryFutureLoadExplanationCache()
    const cacheKey = explanationCacheKey({
      decisionId,
      promptVersion: FUTURE_LOAD_PROMPT_VERSION,
      validatorVersion: EXPLANATION_VALIDATOR_VERSION,
      modelId: verifiedRuntimeIdentity.modelId,
      modelContentDigest: modelDigest,
      factBundleHash: 'a'.repeat(64),
    })
    await cache.putIfActive({
      userId,
      sessionId,
      decisionId,
      cacheKey,
      prose: `${validProse} Use 5 kg for a warm-up.`,
      modelId: verifiedRuntimeIdentity.modelId,
      modelContentDigest: modelDigest,
      servedModelName: verifiedRuntimeIdentity.servedModelName,
      runtimeId: verifiedRuntimeIdentity.runtimeId,
      runtimeAttestationDigest: verifiedRuntimeIdentity.runtimeAttestationDigest,
      promptVersion: FUTURE_LOAD_PROMPT_VERSION,
      validatorVersion: EXPLANATION_VALIDATOR_VERSION,
      factBundleHash: 'a'.repeat(64),
      generateDurationMs: 1,
    })
    const deps = {
      cache,
      getBundles: async () => sampleBundleResult(),
      getConfig: localConfig,
      preflight: async () =>
        ({
          readyForLocalInference: true,
          blockers: [],
          verifiedRuntimeIdentity,
        }) as never,
      compose: () =>
        ({
          explanationGenerator: { synthesize },
        }) as unknown as LlmComposition,
    }

    const repaired = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId,
      deps,
    })
    const cached = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId,
      deps,
    })

    expect(repaired).toMatchObject({ status: 'available', fromCache: false })
    expect(cached).toMatchObject({ status: 'available', fromCache: true })
    expect(synthesize).toHaveBeenCalledTimes(1)
  })

  it('coalesces overlapping misses and returns invalidated when pain linearizes before put', async () => {
    let invalidated = false
    const cache = createMemoryFutureLoadExplanationCache({
      activeState: () =>
        invalidated
          ? { status: 'invalidated', reason: 'post-completion-pain-report' }
          : { status: 'active' },
    })
    const generationStarted = deferred()
    const releaseGeneration = deferred()
    const synthesize = vi.fn(async () => {
      generationStarted.resolve()
      await releaseGeneration.promise
      return {
        status: 'available' as const,
        prose: sampleValidProse(),
        modelId: verifiedRuntimeIdentity.modelId,
        modelContentDigest: modelDigest,
        runtimeId: verifiedRuntimeIdentity.runtimeId,
        promptVersion: FUTURE_LOAD_PROMPT_VERSION,
        factBundleHash: 'a'.repeat(64),
        generatedAt: '2026-07-13T00:00:00.000Z',
      }
    })
    const deps = {
      cache,
      singleFlight: createBoundedAsyncSingleFlight(),
      getBundles: async () => sampleBundleResult(),
      getConfig: localConfig,
      preflight: async () =>
        ({
          readyForLocalInference: true,
          blockers: [],
          verifiedRuntimeIdentity,
        }) as never,
      compose: () =>
        ({ explanationGenerator: { synthesize } }) as unknown as LlmComposition,
    }

    const first = explainFutureLoadDecision({ userId, sessionId, decisionId, deps })
    const second = explainFutureLoadDecision({ userId, sessionId, decisionId, deps })
    await generationStarted.promise
    invalidated = true
    releaseGeneration.resolve()

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'unavailable', reason: 'decision-invalidated' }),
      expect.objectContaining({ status: 'unavailable', reason: 'decision-invalidated' }),
    ])
    expect(synthesize).toHaveBeenCalledTimes(1)
  })

  it('permits a put that linearizes before pain while post-commit purge removes its row', async () => {
    let invalidated = false
    const underlying = createMemoryFutureLoadExplanationCache({
      activeState: () =>
        invalidated
          ? { status: 'invalidated', reason: 'post-completion-pain-report' }
          : { status: 'active' },
    })
    const putCommitted = deferred()
    const releasePutResult = deferred()
    const cache = {
      ...underlying,
      async putIfActive(input: Parameters<typeof underlying.putIfActive>[0]) {
        const result = await underlying.putIfActive(input)
        putCommitted.resolve()
        await releasePutResult.promise
        return result
      },
    }
    const deps = {
      cache,
      singleFlight: createBoundedAsyncSingleFlight(),
      getBundles: async () => sampleBundleResult(),
      getConfig: localConfig,
      preflight: async () =>
        ({
          readyForLocalInference: true,
          blockers: [],
          verifiedRuntimeIdentity,
        }) as never,
      compose: () =>
        ({
          explanationGenerator: {
            synthesize: async () => ({
              status: 'available' as const,
              prose: sampleValidProse(),
              modelId: verifiedRuntimeIdentity.modelId,
              modelContentDigest: modelDigest,
              runtimeId: verifiedRuntimeIdentity.runtimeId,
              promptVersion: FUTURE_LOAD_PROMPT_VERSION,
              factBundleHash: 'a'.repeat(64),
              generatedAt: '2026-07-13T00:00:00.000Z',
            }),
          },
        }) as unknown as LlmComposition,
    }

    const pending = explainFutureLoadDecision({ userId, sessionId, decisionId, deps })
    await putCommitted.promise
    // putIfActive committed first: Explain is linearized before the overlapping pain.
    invalidated = true
    await underlying.deleteBySessionId({ userId, sessionId })
    releasePutResult.resolve()
    await expect(pending).resolves.toMatchObject({
      status: 'available',
      fromCache: false,
    })

    invalidated = false
    await expect(
      underlying.getIfActive({
        userId,
        sessionId,
        decisionId,
        cacheKey: explanationCacheKey({
          decisionId,
          promptVersion: FUTURE_LOAD_PROMPT_VERSION,
          validatorVersion: EXPLANATION_VALIDATOR_VERSION,
          modelId: verifiedRuntimeIdentity.modelId,
          modelContentDigest: modelDigest,
          factBundleHash: 'a'.repeat(64),
        }),
      }),
    ).resolves.toEqual({ status: 'miss' })
  })

  it('degrades cache read/write errors to no-cache success after active-state checks', async () => {
    const base = createMemoryFutureLoadExplanationCache()
    const cache = {
      ...base,
      getIfActive: async () => ({ status: 'cache-unavailable' as const }),
      putIfActive: async () => ({ status: 'cache-unavailable' as const }),
    }
    const synthesize = vi.fn(async () => ({
      status: 'available' as const,
      prose: sampleValidProse(),
      modelId: verifiedRuntimeIdentity.modelId,
      modelContentDigest: modelDigest,
      runtimeId: verifiedRuntimeIdentity.runtimeId,
      promptVersion: FUTURE_LOAD_PROMPT_VERSION,
      factBundleHash: 'a'.repeat(64),
      generatedAt: '2026-07-13T00:00:00.000Z',
    }))

    const result = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId,
      deps: {
        cache,
        singleFlight: createBoundedAsyncSingleFlight(),
        getBundles: async () => sampleBundleResult(),
        getConfig: localConfig,
        preflight: async () =>
          ({
            readyForLocalInference: true,
            blockers: [],
            verifiedRuntimeIdentity,
          }) as never,
        compose: () =>
          ({ explanationGenerator: { synthesize } }) as unknown as LlmComposition,
      },
    })

    expect(result).toMatchObject({ status: 'available', fromCache: false })
    expect(synthesize).toHaveBeenCalledTimes(1)
  })

  it('fails closed without generation when authoritative state cannot be confirmed', async () => {
    const synthesize = vi.fn()
    const cache = {
      ...createMemoryFutureLoadExplanationCache(),
      getIfActive: async () => ({ status: 'state-unavailable' as const }),
    }
    const result = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId,
      deps: {
        cache,
        getBundles: async () => sampleBundleResult(),
        getConfig: localConfig,
        compose: () =>
          ({ explanationGenerator: { synthesize } }) as unknown as LlmComposition,
      },
    })
    expect(result).toMatchObject({ status: 'unavailable', reason: 'llm-not-ready' })
    expect(synthesize).not.toHaveBeenCalled()
  })

  it('returns decision-invalidated without model or cache hit after pain', async () => {
    const synthesize = vi.fn()
    const cache = createMemoryFutureLoadExplanationCache()
    await cache.putIfActive({
      userId,
      sessionId,
      decisionId,
      cacheKey: 'stale',
      prose: 'stale increase paraphrase',
      modelId: 'qwen3.5-9b-q4_k_m',
      modelContentDigest: modelDigest,
      servedModelName: verifiedRuntimeIdentity.servedModelName,
      runtimeId: verifiedRuntimeIdentity.runtimeId,
      runtimeAttestationDigest: verifiedRuntimeIdentity.runtimeAttestationDigest,
      promptVersion: FUTURE_LOAD_PROMPT_VERSION,
      validatorVersion: 'future-load-validator.v2',
      factBundleHash: 'a'.repeat(64),
      generateDurationMs: 1000,
    })

    const bundles = sampleBundleResult()
    if (bundles.status !== 'available') throw new Error('expected available')
    const invalidatedBundle = {
      ...bundles,
      bundles: bundles.bundles.map((entry) => ({
        ...entry,
        factBundle: {
          ...entry.factBundle,
          decision: {
            ...entry.factBundle.decision,
            invalidated: true,
            invalidationReason: 'post-completion-pain-report',
            painReported: true,
          },
        },
      })),
    }

    const result = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId,
      deps: {
        cache,
        getBundles: async () => invalidatedBundle,
        getConfig: localConfig,
        compose: () => {
          throw new Error('compose should not run when invalidated')
        },
        preflight: async () => {
          throw new Error('preflight should not run when invalidated')
        },
      },
    })

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'decision-invalidated',
    })
    expect(synthesize).not.toHaveBeenCalled()
    expect(
      await cache.getIfActive({ userId, sessionId, decisionId, cacheKey: 'stale' }),
    ).toEqual({ status: 'miss' })
  })

  it('maps synthesis failure without inventing prose', async () => {
    const result = await explainFutureLoadDecision({
      userId,
      sessionId,
      decisionId,
      deps: {
        cache: createMemoryFutureLoadExplanationCache(),
        getBundles: async () => sampleBundleResult(),
        getConfig: localConfig,
        preflight: async () =>
          ({
            readyForLocalInference: true,
            blockers: [],
            verifiedRuntimeIdentity,
          }) as never,
        compose: () =>
          ({
            config: localConfig(),
            registry: null,
            activeSettings: {
              modelId: 'qwen3.5-9b-q4_k_m',
              artifacts: { expectedSha256: modelDigest },
            },
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
