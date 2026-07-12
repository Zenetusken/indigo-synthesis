import { describe, expect, it } from 'vitest'
import { MAX_CANONICAL_LOAD_GRAMS } from '@/modules/exercises/domain/load'
import {
  displayLoadValue,
  formatLoad,
  inputLoadToGrams,
  loadUnitLabel,
  maximumDisplayLoadValue,
} from './units'

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

  it('derives the same canonical maximum for metric and imperial input', () => {
    expect(maximumDisplayLoadValue('metric')).toBe(1_000)
    expect(maximumDisplayLoadValue('imperial')).toBe(2_204.623)
    expect(inputLoadToGrams(maximumDisplayLoadValue('metric'), 'metric')).toBe(
      MAX_CANONICAL_LOAD_GRAMS,
    )
    expect(inputLoadToGrams(maximumDisplayLoadValue('imperial'), 'imperial')).toBe(
      MAX_CANONICAL_LOAD_GRAMS,
    )
  })

  it('round-trips sampled integer grams through either display system', () => {
    for (const units of ['metric', 'imperial'] as const) {
      for (let grams = 0; grams <= MAX_CANONICAL_LOAD_GRAMS; grams += 9_973) {
        expect(inputLoadToGrams(displayLoadValue(grams, units), units)).toBe(grams)
      }
    }
  })

  it('rejects display values outside the shared canonical gram bounds', () => {
    expect(inputLoadToGrams(-0.001, 'metric')).toBeNaN()
    expect(inputLoadToGrams(1_000.001, 'metric')).toBeNaN()
    expect(inputLoadToGrams(2_204.624, 'imperial')).toBeNaN()
  })
})
