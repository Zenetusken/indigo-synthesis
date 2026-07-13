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
    // This command evaluates local readiness without changing the application's
    // disabled-by-default environment.
    INDIGO_LLM_MODE: 'local',
    INDIGO_LLM_MODEL_ID: process.env.INDIGO_LLM_MODEL_ID ?? 'qwen3.5-9b-q4_k_m',
    INDIGO_LLM_ENDPOINT: process.env.INDIGO_LLM_ENDPOINT ?? 'http://127.0.0.1:8080/v1',
  })

  const report = await runLlmPreflight(config)
  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(formatLlmPreflightReport(report))
  }

  // This operator command is a readiness gate even when app mode remains disabled.
  if (!report.readyForLocalInference) {
    process.exitCode = 2
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
