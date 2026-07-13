/**
 * Formats a count with a correctly-pluralized noun, e.g. `pluralize(1, 'set')`
 * → "1 set" and `pluralize(3, 'set')` → "3 sets". Pass an explicit plural for
 * irregular nouns.
 */
export function pluralize(count: number, singular: string, plural?: string): string {
  const noun = count === 1 ? singular : (plural ?? `${singular}s`)
  return `${count} ${noun}`
}
