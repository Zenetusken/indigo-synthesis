/**
 * Host preflight for the optional local LLM stack.
 *
 *   pnpm llm:preflight
 *   pnpm llm:preflight --json
 */
import { parseLlmConfig } from '../../src/platform/llm/config'
import {
  formatLlmPreflightReport,
  runLlmPreflight,
} from '../../src/platform/llm/runtime/preflight'

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json')
  const config = parseLlmConfig({
    ...process.env,
    // Preflight defaults to the primary pack when mode is still disabled so operators
    // can validate the host before flipping INDIGO_LLM_MODE=local.
    INDIGO_LLM_MODEL_ID: process.env.INDIGO_LLM_MODEL_ID ?? 'qwen3.5-9b-q4_k_m',
    INDIGO_LLM_ENDPOINT: process.env.INDIGO_LLM_ENDPOINT ?? 'http://127.0.0.1:8080/v1',
  })

  const report = await runLlmPreflight(config)
  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(formatLlmPreflightReport(report))
  }

  // Exit 2 when product-ready local inference is blocked (including GPU required).
  if (!report.readyForLocalInference && report.blockers.length > 0) {
    process.exitCode = 2
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
