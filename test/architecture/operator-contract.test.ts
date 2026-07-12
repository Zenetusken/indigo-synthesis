import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = process.cwd()

describe('clean-clone operator contract', () => {
  it('pins integration tests to the test runtime and development fixture', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(projectRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> }
    const integration = manifest.scripts?.['test:integration'] ?? ''

    expect(integration).toContain('NODE_ENV=test')
    expect(integration).toContain('INDIGO_CONTENT_MODE=development')
  })

  it('provides a safe, copyable E2E environment template', () => {
    const examplePath = resolve(projectRoot, '.env.e2e.example')
    expect(existsSync(examplePath)).toBe(true)

    const example = readFileSync(examplePath, 'utf8')
    expect(example).toContain('E2E_DATABASE_URL=postgresql://')
    expect(example).toContain('/indigo_synthesis_e2e')
    expect(example).toContain('E2E_BETTER_AUTH_SECRET=')
    expect(example).not.toMatch(/^DATABASE_URL=/m)
    expect(example).not.toMatch(/^BETTER_AUTH_SECRET=/m)
  })

  it('documents browser installation and disposable database preparation', () => {
    const readme = readFileSync(resolve(projectRoot, 'README.md'), 'utf8')

    expect(readme).toContain('pnpm install --frozen-lockfile')
    expect(readme).toContain('pnpm exec playwright install chromium')
    expect(readme).toContain('cp .env.e2e.example .env.e2e.local')
    expect(readme).toContain('drops and recreates')
  })

  it('keeps migration SQL byte-stable with a canonical LF checkout policy', () => {
    const attributes = readFileSync(resolve(projectRoot, '.gitattributes'), 'utf8')
    expect(attributes).toMatch(/^drizzle\/\*\.sql text eol=lf$/m)

    const migration = readFileSync(
      resolve(projectRoot, 'drizzle/0004_magenta_the_spike.sql'),
    )
    expect(migration.includes(13)).toBe(false)
    expect(createHash('sha256').update(migration).digest('hex')).toBe(
      'e5d7105d56a02ba8874fef8f2a724981363e74f809b22d909a0e7cec75564ba0',
    )
  })
})
