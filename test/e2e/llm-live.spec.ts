import { expect, test } from '@playwright/test'
import { parseLlmConfig } from '@/platform/llm/config'
import { runLlmPreflight } from '@/platform/llm/runtime/preflight'
import {
  bindE2eProcessEnv,
  bootstrapAndSignIn,
  clearApplicationData,
  completeAllSetsAtTarget,
  completeSetup,
  completeWorkoutToHistory,
  generateAndActivate,
} from './support/journey'

// Point the test process at the disposable E2E database before server-side modules run.
bindE2eProcessEnv()

const expectedModelId = process.env.INDIGO_LLM_MODEL_ID ?? 'qwen3.5-9b-q4_k_m'

/**
 * Live GPU / local LLM Playwright suite.
 * Opt-in only (`pnpm test:e2e:llm`). Default `pnpm test:e2e` ignores this file.
 *
 * Validates the product History path with INDIGO_LLM_MODE=local on the Next server:
 * codes remain authoritative; on-demand Explain returns grounded prose (or fails closed).
 */
test.describe('live GPU History explanations', () => {
  test.beforeAll(async () => {
    const config = parseLlmConfig(process.env)
    if (config.mode !== 'local') {
      throw new Error(
        'llm-live e2e requires INDIGO_LLM_MODE=local (playwright.llm.config.ts should set this).',
      )
    }
    if (!config.requireGpu) {
      throw new Error(
        'llm-live e2e requires INDIGO_LLM_REQUIRE_GPU=true (product GPU path).',
      )
    }

    const readiness = await runLlmPreflight(config)
    if (!readiness.readyForLocalInference) {
      throw new Error(
        [
          'LLM preflight is not ready for live e2e (GPU + loopback server required).',
          `gpu=${readiness.gpu.state}`,
          `blockers=${readiness.blockers.join(' | ') || '(none)'}`,
          'Start with: pnpm llm:preflight && pnpm llm:serve',
        ].join(' '),
      )
    }
  })

  test.beforeEach(async () => {
    await clearApplicationData()
  })

  test('explains completed future-load decisions with grounded local prose', async ({
    page,
  }) => {
    await bootstrapAndSignIn(page)
    await completeSetup(page)
    await generateAndActivate(page)

    await page.getByRole('button', { name: 'Start workout' }).click()
    await expect(page).toHaveURL(/\/workouts\//)
    await expect(page.getByRole('button', { name: 'Complete set' }).first()).toBeVisible()

    // RPE 8 at target → development.adjustment.increase (threshold is > 8).
    await completeAllSetsAtTarget(page, '8')
    await completeWorkoutToHistory(page)

    await expect(
      page.getByRole('heading', { name: 'Future-load decisions' }),
    ).toBeVisible()
    await expect(
      page.getByText(
        'Development policy only. These deterministic outputs are not human-reviewed',
      ),
    ).toBeVisible()

    const reasonCodes = page
      .locator('code')
      .filter({ hasText: /development\.adjustment\./ })
    await expect(reasonCodes.first()).toBeVisible()
    await expect(reasonCodes.first()).toContainText('rule')

    // Prefer an increase decision when present (full target completion path).
    const increaseCode = page
      .locator('code')
      .filter({ hasText: /development\.adjustment\.increase/ })
    const hasIncrease = (await increaseCode.count()) > 0
    if (hasIncrease) {
      await expect(increaseCode.first()).toBeVisible()
    }

    const decisionItem = hasIncrease
      ? page.locator('li').filter({ has: increaseCode.first() }).first()
      : page.locator('li').filter({ has: reasonCodes.first() }).first()

    const explain = decisionItem.getByRole('button', {
      name: 'Explain in plain language',
    })
    await expect(explain).toBeVisible()
    await explain.click()

    // Success path: grounded paraphrase, not a new decision.
    await expect(
      decisionItem.getByText(
        'Inferred paraphrase of the stored rule (not a new decision)',
      ),
    ).toBeVisible({ timeout: 90_000 })

    await expect(decisionItem.getByText(/Local model/)).toBeVisible()
    await expect(decisionItem.getByText(new RegExp(expectedModelId))).toBeVisible()
    await expect(decisionItem.getByText(/rules still\s+authoritative/)).toBeVisible()

    const proseText = await decisionItem
      .locator('p')
      .filter({ hasNotText: /Inferred paraphrase|Local model|rules still/ })
      .first()
      .innerText()
    expect(proseText.trim().length).toBeGreaterThan(40)

    // Codes remain authoritative after successful explanation.
    await expect(reasonCodes.first()).toBeVisible()
    await expect(
      page.getByText('Plain-language explanations are off on this instance'),
    ).toHaveCount(0)
    await expect(page.getByText('Could not produce a grounded explanation')).toHaveCount(
      0,
    )

    // Soft grounding: increase path should mention known load labels when present.
    if (hasIncrease) {
      // Setup fills 60 kg; increase steps by 1 kg in the development fixture.
      expect(proseText).toMatch(/60(?:\s*kg)?/)
      expect(proseText).toMatch(/61(?:\s*kg)?/)
    }

    // Re-explain the same decision: should hit prose cache (no second model wait).
    await explain.click()
    await expect(decisionItem.getByText(/· cached/)).toBeVisible({ timeout: 15_000 })
    await expect(reasonCodes.first()).toBeVisible()

    // Second decision (when present): codes stay visible whether prose succeeds or soft-fails.
    const explainButtons = page.getByRole('button', {
      name: 'Explain in plain language',
    })
    const count = await explainButtons.count()
    expect(count).toBeGreaterThan(0)
    if (count > 1) {
      await explainButtons.nth(1).click()
      await expect
        .poll(
          async () => {
            const paraphrases = await page
              .getByText('Inferred paraphrase of the stored rule (not a new decision)')
              .count()
            const softFail = await page
              .getByText('The rule codes above still apply', { exact: false })
              .count()
            return paraphrases >= 1 && (paraphrases >= 2 || softFail >= 1)
          },
          { timeout: 90_000 },
        )
        .toBe(true)
      await expect(reasonCodes.first()).toBeVisible()
    }
  })
})
