import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const postgresLib = dirname(require.resolve('pg'))

function pinnedSource(name: 'query' | 'utils'): {
  readonly digest: string
  readonly source: string
} {
  const source = readFileSync(resolve(postgresLib, `${name}.js`), 'utf8')
  return {
    digest: createHash('sha256').update(source).digest('hex'),
    source,
  }
}

describe('pinned node-postgres query-value contract', () => {
  it('pins deferred value retention and the serializer used for eager UoW capture', () => {
    const query = pinnedSource('query')
    const utils = pinnedSource('utils')

    expect(query.digest).toBe(
      '4253bb48364243573c330a2d5827a0f306f632f84f5ac56feaa3ac83f2293001',
    )
    expect(utils.digest).toBe(
      '97fb5d56e301d00412e85ce91d796a61c79493dc03ae5adc05995ed8a0ed7936',
    )

    // Query retains caller values until a possibly later bind. The UoW must therefore invoke
    // this exact reviewed conversion synchronously and copy any Buffer result before dispatch.
    expect(query.source).toContain('this.values = config.values')
    expect(query.source).toContain('valueMapper: utils.prepareValue')
    expect(utils.source).toContain(
      'return prepareValue(val.toPostgres(prepareValue), seen)',
    )
    expect(utils.source).toContain('return JSON.stringify(val)')
  })
})
