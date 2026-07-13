/**
 * Offline (required) + optional live probe for the local LLM grounded-explanation layer.
 *
 * Usage:
 *   pnpm llm:validate-baseline
 *   pnpm llm:validate-baseline --json
 *   INDIGO_LLM_LIVE=1 INDIGO_LLM_ENDPOINT=http://127.0.0.1:8080/v1 \
 *     INDIGO_LLM_MODEL_ID=qwen3.5-9b-q4_k_m pnpm llm:validate-baseline --json
 *
 * Exit codes:
 *   0 — offline baseline passed (live probe optional; unreachable live does not fail)
 *   1 — offline baseline failed
 */
import {
  buildMeasurementSnapshot,
  formatMeasurementSummary,
} from '../../src/platform/llm/baseline/metrics'
import {
  formatLiveProbeReport,
  type LiveProbeReport,
  runLiveProbe,
} from '../../src/platform/llm/baseline/run-live-probe'
import {
  formatOfflineBaselineReport,
  runOfflineBaseline,
} from '../../src/platform/llm/baseline/run-offline-baseline'

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json')
  const started = performance.now()
  const offline = await runOfflineBaseline()
  const offlineDurationMs = Math.round(performance.now() - started)

  if (!asJson) {
    console.log(formatOfflineBaselineReport(offline))
    console.log('')
  }

  if (!offline.ok) {
    process.exitCode = 1
    if (!asJson) {
      console.error(
        'Offline baseline FAILED — fix validation/registry before live probes.',
      )
    } else {
      console.log(
        JSON.stringify(
          buildMeasurementSnapshot({
            offline,
            offlineDurationMs,
            live: null,
          }),
          null,
          2,
        ),
      )
    }
    return
  }

  if (!asJson) {
    console.log('Offline baseline PASSED — calibrated contract baseline is green.')
  }

  let live: LiveProbeReport | null = null
  const liveEnabled =
    process.env.INDIGO_LLM_LIVE === '1' || process.env.INDIGO_LLM_LIVE === 'true'

  if (liveEnabled) {
    const endpoint = process.env.INDIGO_LLM_ENDPOINT ?? 'http://127.0.0.1:8080/v1'
    const modelId = process.env.INDIGO_LLM_MODEL_ID ?? 'qwen3.5-9b-q4_k_m'
    const digest = process.env.INDIGO_LLM_MODEL_SHA256
    live = await runLiveProbe({
      endpoint,
      modelId,
      modelContentDigest: digest,
    })
    if (!asJson) {
      console.log('')
      console.log(formatLiveProbeReport(live))
      if (live.availableCount === 0) {
        console.log(
          'Note: no live case produced validated prose. Offline baseline still passed; start llama-server and re-run for model calibration.',
        )
      } else {
        console.log(
          `Live calibration sample: ${live.availableCount}/${live.cases.length} cases produced validation-passing prose.`,
        )
      }
    }
  } else if (!asJson) {
    console.log(
      'Live probe skipped (set INDIGO_LLM_LIVE=1 with a loopback endpoint to exercise a real model).',
    )
  }

  const snapshot = buildMeasurementSnapshot({
    offline,
    offlineDurationMs,
    live,
  })

  if (asJson) {
    console.log(JSON.stringify(snapshot, null, 2))
  } else {
    console.log('')
    console.log(formatMeasurementSummary(snapshot))
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
