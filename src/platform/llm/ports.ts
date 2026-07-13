import type {
  ExplanationGenerationRequest,
  ExplanationGenerationResult,
  LanguageModelCompleteRequest,
  LanguageModelCompleteResult,
} from './types'

/** Low-level, model-agnostic completion port. */
export interface LanguageModelPort {
  complete(request: LanguageModelCompleteRequest): Promise<LanguageModelCompleteResult>
}

/** Product-level grounded explanation port (ADR 0006 / explanation contract). */
export interface ExplanationGenerationPort {
  synthesize(request: ExplanationGenerationRequest): Promise<ExplanationGenerationResult>
}
