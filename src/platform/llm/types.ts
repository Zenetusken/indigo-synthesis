export type LlmMode = 'disabled' | 'local'

export type LlmUnavailableReason =
  | 'disabled'
  | 'runtime-unreachable'
  | 'timeout'
  | 'validation-failed'
  | 'model-error'
  | 'invalidated-decision'
  | 'config-error'

export type ChatMessageRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  readonly role: ChatMessageRole
  readonly content: string
}

export interface SamplingParams {
  readonly temperature: number
  readonly topP: number
  readonly topK: number
  readonly minP: number
  readonly presencePenalty: number
  readonly repetitionPenalty: number
  readonly maxTokens: number
}

export interface LanguageModelCompleteRequest {
  readonly messages: readonly ChatMessage[]
  readonly sampling: SamplingParams
  readonly timeoutMs: number
  readonly servedModelName: string
  readonly enableThinking: boolean
  readonly modelId: string
  readonly modelContentDigest: string
}

export type LanguageModelCompleteResult =
  | {
      readonly status: 'available'
      readonly text: string
      readonly modelId: string
      readonly modelContentDigest: string
      readonly runtimeId: string
    }
  | {
      readonly status: 'unavailable'
      readonly reason: LlmUnavailableReason
      readonly detail: string | null
    }

export interface ExplanationGenerationRequest {
  readonly factBundle: import('./explanation/fact-bundle').ExplanationFactBundle
  readonly promptVersion: string
  readonly timeoutMs: number
}

export type ExplanationGenerationResult =
  | {
      readonly status: 'available'
      readonly prose: string
      readonly modelId: string
      readonly modelContentDigest: string
      readonly runtimeId: string
      readonly promptVersion: string
      readonly factBundleHash: string
      readonly generatedAt: string
    }
  | {
      readonly status: 'unavailable'
      readonly reason: LlmUnavailableReason
      readonly detail: string | null
    }
