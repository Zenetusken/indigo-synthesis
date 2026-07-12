export type DisplayUnits = 'metric' | 'imperial'

const gramsPerDisplayUnit: Readonly<Record<DisplayUnits, number>> = {
  metric: 1_000,
  imperial: 453.59237,
}

export function loadUnitLabel(units: DisplayUnits): 'kg' | 'lb' {
  return units === 'metric' ? 'kg' : 'lb'
}

export function displayLoadValue(grams: number, units: DisplayUnits): number {
  return Number((grams / gramsPerDisplayUnit[units]).toFixed(3))
}

export function inputLoadToGrams(value: number, units: DisplayUnits): number {
  if (!Number.isFinite(value) || value < 0) return Number.NaN
  return Math.round(value * gramsPerDisplayUnit[units])
}

export function formatLoad(grams: number | null, units: DisplayUnits): string {
  if (grams === null) return 'Unavailable'
  return `${(grams / gramsPerDisplayUnit[units]).toLocaleString('en', {
    maximumFractionDigits: 2,
  })} ${loadUnitLabel(units)}`
}
