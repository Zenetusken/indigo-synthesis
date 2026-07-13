import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFakeLanguageModel } from '../adapters/fake'
import { parseModelSettings } from '../model-settings'
import { FUTURE_LOAD_PROMPT_VERSION } from '../prompts/future-load.v3'
import type { ExplanationFactBundle } from './fact-bundle'
import { createExplanationGenerationPort } from './synthesize'

const settings = parseModelSettings(
  JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'llm/models/qwen3.5-9b-q4_k_m/settings.json'),
      'utf8',
    ),
  ),
)

function sampleBundle(): ExplanationFactBundle {
  return {
    contractVersion: '2',
    bundleKind: 'future-load-decision',
    locale: 'en',
    contentMode: 'development',
    subject: { units: 'metric' },
    decision: {
      decisionId: 'dec-1',
      sessionId: 'ses-1',
      exerciseCode: 'back-squat',
      kind: 'increase',
      currentLoadGrams: 100_000,
      proposedLoadGrams: 102_500,
      invalidated: false,
      invalidationReason: null,
      setFacts: [
        {
          ordinal: 1,
          status: 'performed',
          loadGrams: 100_000,
          repetitions: 5,
          rpe: 7,
          explicitlyConfirmed: true,
        },
      ],
      painReported: false,
    },
    grounding: {
      reasonCode: 'development.adjustment.increase',
      ruleId: 'development-adjustment',
      ruleVersion: '0.0.1-development',
      engineVersion: '0.1.0-development',
      methodologyId: 'development',
      methodologyVersion: '0.0.1-development',
    },
    display: {
      currentLoadLabel: '100 kg',
      proposedLoadLabel: '102.5 kg',
      exerciseName: 'Back squat',
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
  }
}

const groundedProse = [
  'Back squat future load moves from 100 kg to 102.5 kg because performed sets met the target',
  'at acceptable effort (reason development.adjustment.increase, rule 0.0.1-development).',
  'This is an unreviewed development fixture, not human-reviewed coaching guidance.',
].join(' ')

describe('createExplanationGenerationPort', () => {
  it('returns available prose when the model is grounded', async () => {
    const port = createExplanationGenerationPort({
      languageModel: createFakeLanguageModel(async () => ({
        status: 'available',
        text: groundedProse,
        modelId: settings.modelId,
        modelContentDigest: 'b'.repeat(64),
        runtimeId: 'fake',
      })),
      modelSettings: settings,
      modelContentDigest: 'b'.repeat(64),
      now: () => new Date('2026-07-12T12:00:00.000Z'),
    })

    const result = await port.synthesize({
      factBundle: sampleBundle(),
      promptVersion: FUTURE_LOAD_PROMPT_VERSION,
      timeoutMs: 1000,
    })

    expect(result.status).toBe('available')
    if (result.status === 'available') {
      expect(result.prose).toContain('100 kg')
      expect(result.promptVersion).toBe(FUTURE_LOAD_PROMPT_VERSION)
      expect(result.generatedAt).toBe('2026-07-12T12:00:00.000Z')
    }
  })

  it('returns validation-failed when prose invents numbers', async () => {
    const port = createExplanationGenerationPort({
      languageModel: createFakeLanguageModel(async () => ({
        status: 'available',
        text: `${groundedProse} Or try 120 kg.`,
        modelId: settings.modelId,
        modelContentDigest: 'b'.repeat(64),
        runtimeId: 'fake',
      })),
      modelSettings: settings,
      modelContentDigest: 'b'.repeat(64),
    })

    await expect(
      port.synthesize({
        factBundle: sampleBundle(),
        promptVersion: FUTURE_LOAD_PROMPT_VERSION,
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'validation-failed',
    })
  })

  it('returns disabled from the language model without throwing', async () => {
    const port = createExplanationGenerationPort({
      languageModel: createFakeLanguageModel(async () => ({
        status: 'unavailable',
        reason: 'disabled',
        detail: 'off',
      })),
      modelSettings: settings,
      modelContentDigest: 'unverified',
    })

    await expect(
      port.synthesize({
        factBundle: sampleBundle(),
        promptVersion: FUTURE_LOAD_PROMPT_VERSION,
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'disabled' })
  })

  it('fails closed before model I/O when a persisted reason has no safe template', async () => {
    const languageModel = createFakeLanguageModel(async () => {
      throw new Error('model must not be called')
    })
    const port = createExplanationGenerationPort({
      languageModel,
      modelSettings: settings,
      modelContentDigest: 'b'.repeat(64),
    })
    const base = sampleBundle()
    const unsupported: ExplanationFactBundle = {
      ...base,
      decision: {
        ...base.decision,
        kind: 'blocked',
        proposedLoadGrams: 100_000,
      },
      grounding: {
        ...base.grounding,
        reasonCode: 'adjustment.policy-unavailable',
        ruleVersion: 'unavailable',
      },
      display: {
        ...base.display,
        proposedLoadLabel: '100 kg',
      },
    }

    await expect(
      port.synthesize({
        factBundle: unsupported,
        promptVersion: FUTURE_LOAD_PROMPT_VERSION,
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'config-error',
      detail: expect.stringMatching(/adjustment\.policy-unavailable/),
    })
  })
})
