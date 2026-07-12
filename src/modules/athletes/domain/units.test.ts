import { describe, expect, it } from 'vitest'
import { displayLoadValue, formatLoad, inputLoadToGrams, loadUnitLabel } from './units'

describe('canonical load display units', () => {
  it('round-trips canonical grams through a three-decimal imperial input', () => {
    const displayed = displayLoadValue(60_000, 'imperial')
    expect(displayed).toBe(132.277)
    expect(inputLoadToGrams(displayed, 'imperial')).toBe(60_000)
  })

  it('keeps metric values and labels explicit', () => {
    expect(displayLoadValue(60_500, 'metric')).toBe(60.5)
    expect(inputLoadToGrams(60.5, 'metric')).toBe(60_500)
    expect(loadUnitLabel('metric')).toBe('kg')
    expect(formatLoad(60_500, 'metric')).toBe('60.5 kg')
  })

  it('does not invent a value for missing load data', () => {
    expect(formatLoad(null, 'imperial')).toBe('Unavailable')
  })
})
