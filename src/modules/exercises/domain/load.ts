export const MIN_CANONICAL_LOAD_GRAMS = 0
export const MAX_CANONICAL_LOAD_GRAMS = 1_000_000

export function isCanonicalLoadGrams(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_CANONICAL_LOAD_GRAMS &&
    value <= MAX_CANONICAL_LOAD_GRAMS
  )
}
