import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const nodePostgresDist = dirname(require.resolve('drizzle-orm/node-postgres'))
const drizzleDist = resolve(nodePostgresDist, '..')

function pinnedSource(path: string): {
  readonly digest: string
  readonly source: string
} {
  const source = readFileSync(path, 'utf8')
  return {
    digest: createHash('sha256').update(source).digest('hex'),
    source,
  }
}

describe('pinned Drizzle node-postgres bridge contract', () => {
  it('pins the reviewed query-config, client-construction, and shim-classification sources', () => {
    const session = pinnedSource(resolve(nodePostgresDist, 'session.js'))
    const driver = pinnedSource(resolve(nodePostgresDist, 'driver.js'))
    const utils = pinnedSource(resolve(drizzleDist, 'utils.js'))

    expect(session.digest).toBe(
      'cfcc5e8c5a4a8c02603905e8fad619981af13a42e3221b58e2878be0a4058855',
    )
    expect(driver.digest).toBe(
      'f139b074df4d68f5c8d65e5044e9dda102c861b4565de023348b3e2dddf8531b',
    )
    expect(utils.digest).toBe(
      '6363d99f639c5d7c19d4862d5126f7e9e6148fd7f226de5407e1d4fb9f2ecdae',
    )

    expect(session.source).toContain('this.rawQueryConfig = {')
    expect(session.source).toContain('this.queryConfig = {')
    expect(session.source).toContain('rowMode: "array"')
    expect(session.source).toContain('return await client.query(rawQuery, params)')
    expect(session.source).toContain('return await client.query(query, params)')
    expect(session.source).toContain(
      'this.client instanceof Pool || Object.getPrototypeOf(this.client).constructor.name.includes("Pool")',
    )
    expect(driver.source).toContain('db.$client = client')
    expect(driver.source).toContain('if (isConfig(params[0])) {')
    expect(driver.source).toContain('return construct(params[0], params[1])')
    expect(utils.source).toContain('if (data.constructor.name !== "Object") return false')
    expect(utils.source).toContain('if (Object.keys(data).length === 0) return true')
    expect(utils.source).toContain('return false')
  })
})
