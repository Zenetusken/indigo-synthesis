import type { LanguageModelPort } from '../ports'
import type { LanguageModelCompleteResult } from '../types'

export function createDisabledLanguageModel(): LanguageModelPort {
  return {
    async complete(): Promise<LanguageModelCompleteResult> {
      return {
        status: 'unavailable',
        reason: 'disabled',
        detail: 'Local language generation is disabled (INDIGO_LLM_MODE=disabled).',
      }
    },
  }
}
