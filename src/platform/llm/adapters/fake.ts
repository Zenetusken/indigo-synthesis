import type { LanguageModelPort } from '../ports'
import type { LanguageModelCompleteRequest, LanguageModelCompleteResult } from '../types'

/**
 * Deterministic test double. Returns a template that includes request metadata so
 * validation tests can inject grounded prose without a real model.
 */
export function createFakeLanguageModel(
  respond: (
    request: LanguageModelCompleteRequest,
  ) => LanguageModelCompleteResult | Promise<LanguageModelCompleteResult>,
): LanguageModelPort {
  return {
    async complete(request): Promise<LanguageModelCompleteResult> {
      return respond(request)
    },
  }
}
