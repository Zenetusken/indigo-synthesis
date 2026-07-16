import pg from 'pg'

type PgRuntimeWithUtils = typeof pg & {
  readonly utils: {
    readonly prepareValue: (value: unknown) => unknown
  }
}

// pg 8.22.0 exposes this conversion at runtime but not in @types/pg. The architecture contract
// pins both the converter and deferred-query source whose behavior makes eager capture necessary.
const preparePgValue = (pg as PgRuntimeWithUtils).utils.prepareValue

/** Converts a parameter immediately into node-postgres's stable wire-value domain. */
export function prepareStablePostgresValue(value: unknown): Buffer | null | string {
  const prepared = preparePgValue(value)
  if (prepared === null || prepared === undefined) return null
  if (typeof prepared === 'string') return prepared
  if (Buffer.isBuffer(prepared)) return Buffer.from(prepared)
  throw new TypeError('PostgreSQL produced an unsupported prepared parameter value.')
}
