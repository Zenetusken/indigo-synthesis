/** Shared suite selection keeps the default and live-GPU Playwright contracts disjoint. */
export const defaultE2eSuiteSelection = {
  testMatch: '**/*.spec.ts',
  testIgnore: ['**/llm-live.spec.ts'],
}

export const liveLlmE2eSuiteSelection = {
  testMatch: '**/llm-live.spec.ts',
}
