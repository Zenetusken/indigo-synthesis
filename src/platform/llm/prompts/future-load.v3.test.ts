import { describe, expect, it } from 'vitest'
import { GOLDEN_BASELINE_CASES } from '../baseline/golden-cases'
import { buildFutureLoadMessages, FUTURE_LOAD_PROMPT_VERSION } from './future-load.v3'

describe('future-load.v3 prompt', () => {
  it('pins the closed-output contract to the canonical grounded paragraph', () => {
    const skipped = GOLDEN_BASELINE_CASES.find((entry) => entry.id === 'hold-skipped-set')
    expect(skipped).toBeDefined()
    if (!skipped) throw new Error('missing hold-skipped-set golden')

    const messages = buildFutureLoadMessages(skipped.factBundle)
    const prompt = messages.map((message) => message.content).join('\n')

    expect(FUTURE_LOAD_PROMPT_VERSION).toBe('future-load.v3')
    expect(skipped.factBundle.contractVersion).toBe('2')
    expect(prompt).not.toContain('skipReason')
    expect(prompt).toContain('Return exactly the Required paragraph')
    expect(prompt).toContain(skipped.acceptedProse)
  })
})
