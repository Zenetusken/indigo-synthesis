/**
 * Dry-run: complete a fixture session → FactBundles → live GPU synthesize.
 * Uses a disposable PostgreSQL database (does not pollute the main app DB).
 *
 * Prerequisites:
 *   - GPU llama-server with pack model on loopback (e.g. pnpm llm:serve after reboot)
 *   - INTEGRATION_ADMIN_DATABASE_URL or DATABASE_URL for disposable DB creation
 *
 *   pnpm llm:dry-run-synthesize
 *   INDIGO_LLM_ENDPOINT=http://127.0.0.1:8080/v1 pnpm llm:dry-run-synthesize
 */
import {
  createOwnerWithBootstrapCode,
  issueOwnerBootstrap,
} from '../../src/modules/identity/bootstrap/owner-bootstrap'
import { resetAuthForTests } from '../../src/modules/identity/infrastructure/auth'
import { getFutureLoadFactBundlesForSession } from '../../src/modules/training/application/future-load-fact-bundle'
import {
  completeSet,
  completeWorkout,
  getWorkoutSession,
  startWorkout,
} from '../../src/modules/training/application/workouts'
import { resetServerConfigForTests } from '../../src/platform/config/server'
import { closeDb } from '../../src/platform/db/client'
import {
  createDisposableIntegrationDatabase,
  type DisposableIntegrationDatabase,
} from '../../src/platform/db/disposable-integration-database'
import { migrateDatabase } from '../../src/platform/db/migrate'
import { assertDatabaseReady } from '../../src/platform/db/preflight'
import { newUuidV7 } from '../../src/platform/ids/uuid-v7'
import { composeLlmStack } from '../../src/platform/llm/composition'
import { parseLlmConfig } from '../../src/platform/llm/config'
import { FUTURE_LOAD_PROMPT_VERSION } from '../../src/platform/llm/prompts/future-load.v1'
import { runLlmPreflight } from '../../src/platform/llm/runtime/preflight'
import {
  resetProductData,
  seedCoherentProgram,
  TEST_NOW,
  TEST_TARGET_LOAD_GRAMS,
  TEST_TARGET_REPETITIONS,
} from '../../test/integration/training/harness'

async function main(): Promise<void> {
  const endpoint = process.env.INDIGO_LLM_ENDPOINT ?? 'http://127.0.0.1:8080/v1'
  const modelId = process.env.INDIGO_LLM_MODEL_ID ?? 'qwen3.5-9b-q4_k_m'
  const digest =
    process.env.INDIGO_LLM_MODEL_SHA256 ??
    '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8'
  const timeoutMs = Number(process.env.INDIGO_LLM_TIMEOUT_MS ?? '60000')

  process.env.INDIGO_CONTENT_MODE = 'development'
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'test'
  process.env.INDIGO_LLM_MODE = 'local'
  process.env.INDIGO_LLM_MODEL_ID = modelId
  process.env.INDIGO_LLM_ENDPOINT = endpoint
  process.env.INDIGO_LLM_MODEL_SHA256 = digest
  process.env.INDIGO_LLM_TIMEOUT_MS = String(timeoutMs)
  process.env.INDIGO_LLM_REQUIRE_GPU = process.env.INDIGO_LLM_REQUIRE_GPU ?? 'true'

  console.log('=== 1) LLM preflight ===')
  const llmConfig = parseLlmConfig(process.env)
  const preflight = await runLlmPreflight(llmConfig)
  console.log(
    JSON.stringify(
      {
        ready: preflight.readyForLocalInference,
        gpu: preflight.gpu.state,
        endpoint: preflight.endpoint,
        blockers: preflight.blockers,
      },
      null,
      2,
    ),
  )
  if (!preflight.readyForLocalInference) {
    console.error('Preflight not ready for local GPU inference. Aborting dry-run.')
    process.exitCode = 2
    return
  }

  console.log('\n=== 2) Disposable DB + completed fixture session ===')
  let database: DisposableIntegrationDatabase | undefined
  try {
    database = createDisposableIntegrationDatabase({
      administrationUrl: process.env.INTEGRATION_ADMIN_DATABASE_URL,
      suite: 'llm_dry_run',
    })
    await database.create()
    database.activateDatabaseUrl()
    resetServerConfigForTests()
    resetAuthForTests()
    await closeDb()
    await migrateDatabase()
    await assertDatabaseReady()
    await resetProductData()

    const bootstrap = await issueOwnerBootstrap({ ttlMinutes: 15 })
    const owner = await createOwnerWithBootstrapCode({
      name: 'LLM Dry-Run Owner',
      email: `llm-dry-run-${Date.now()}@example.test`,
      password: 'llm-dry-run-password-long-enough',
      code: bootstrap.code,
    })

    const seeded = await seedCoherentProgram(owner.id)
    const sessionId = await startWorkout(
      owner.id,
      seeded.currentWorkoutId,
      newUuidV7(),
      TEST_NOW,
    )
    const session = await getWorkoutSession(owner.id, sessionId)
    const setId = session?.exercises[0]?.sets[0]?.id
    if (!session || !setId) throw new Error('Fixture session has no set.')

    await completeSet({
      userId: owner.id,
      sessionId,
      setId,
      commandId: newUuidV7(),
      actualLoadGrams: TEST_TARGET_LOAD_GRAMS,
      actualRepetitions: TEST_TARGET_REPETITIONS,
      rpe: 7,
      note: null,
    })
    await completeWorkout({
      userId: owner.id,
      sessionId,
      commandId: newUuidV7(),
      noPainAttested: true,
    })

    console.log(
      JSON.stringify(
        {
          userId: owner.id,
          sessionId,
          exercise: session.exercises[0]?.exerciseCode,
        },
        null,
        2,
      ),
    )

    console.log('\n=== 3) Application FactBundles ===')
    const bundlesResult = await getFutureLoadFactBundlesForSession(owner.id, sessionId)
    if (bundlesResult.status !== 'available') {
      console.error('FactBundles unavailable:', bundlesResult)
      process.exitCode = 1
      return
    }
    console.log(
      JSON.stringify(
        {
          decisionCount: bundlesResult.bundles.length,
          buildErrors: bundlesResult.buildErrors,
          decisions: bundlesResult.bundles.map((item) => ({
            decisionId: item.decision.id,
            exerciseCode: item.decision.exerciseCode,
            decision: item.decision.decision,
            reasonCode: item.decision.reasonCode,
            loads: {
              currentGrams: item.decision.currentLoadGrams,
              nextGrams: item.decision.nextLoadGrams,
            },
            factBundleHash: item.factBundleHash,
            display: item.factBundle.display,
          })),
        },
        null,
        2,
      ),
    )
    if (bundlesResult.buildErrors.length > 0 || bundlesResult.bundles.length === 0) {
      console.error('No clean FactBundles to synthesize.')
      process.exitCode = 1
      return
    }

    console.log('\n=== 4) Live synthesize (GPU model) ===')
    const stack = composeLlmStack(llmConfig)
    if (!stack.explanationGenerator || !stack.activeSettings) {
      console.error('Explanation generator not composed.')
      process.exitCode = 1
      return
    }

    const results: unknown[] = []
    for (const item of bundlesResult.bundles) {
      const started = performance.now()
      const synthesis = await stack.explanationGenerator.synthesize({
        factBundle: item.factBundle,
        promptVersion: FUTURE_LOAD_PROMPT_VERSION,
        timeoutMs,
      })
      const durationMs = Math.round(performance.now() - started)
      results.push({
        decisionId: item.decision.id,
        exerciseCode: item.decision.exerciseCode,
        reasonCode: item.decision.reasonCode,
        durationMs,
        synthesis:
          synthesis.status === 'available'
            ? {
                status: synthesis.status,
                modelId: synthesis.modelId,
                modelContentDigest: synthesis.modelContentDigest,
                runtimeId: synthesis.runtimeId,
                promptVersion: synthesis.promptVersion,
                factBundleHash: synthesis.factBundleHash,
                prose: synthesis.prose,
              }
            : {
                status: synthesis.status,
                reason: synthesis.reason,
                detail: synthesis.detail,
              },
      })
      if (synthesis.status === 'available') {
        console.log(
          `\n--- ${item.decision.exerciseCode} (${item.decision.reasonCode}) ---`,
        )
        console.log(synthesis.prose)
        console.log(`(${durationMs} ms, model=${synthesis.modelId})`)
      } else {
        console.log(
          `\n--- ${item.decision.exerciseCode}: UNAVAILABLE ${synthesis.reason} — ${synthesis.detail} ---`,
        )
      }
    }

    const available = results.filter(
      (row) =>
        typeof row === 'object' &&
        row !== null &&
        'synthesis' in row &&
        (row as { synthesis: { status: string } }).synthesis.status === 'available',
    ).length

    console.log('\n=== 5) Dry-run summary ===')
    console.log(
      JSON.stringify(
        {
          endpoint,
          modelId,
          requireGpu: llmConfig.requireGpu,
          factBundles: bundlesResult.bundles.length,
          synthesizeAvailable: available,
          synthesizeTotal: results.length,
          ok: available === results.length && available > 0,
          results,
        },
        null,
        2,
      ),
    )

    if (available !== results.length || available === 0) {
      process.exitCode = 3
    }
  } finally {
    await closeDb().catch(() => undefined)
    resetServerConfigForTests()
    resetAuthForTests()
    if (database) {
      try {
        database.restoreDatabaseUrl()
      } catch {
        /* ignore */
      }
      await database.cleanup().catch(() => undefined)
    }
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
