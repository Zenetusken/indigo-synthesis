import { describe, expect, it } from 'vitest'
import { InvalidServerConfigurationError, parseServerConfig } from './server'

const validInput = {
  DATABASE_URL: 'postgresql://indigo:secret@localhost:5432/indigo',
  BETTER_AUTH_SECRET: 'a-development-secret-that-is-long-enough',
  BETTER_AUTH_URL: 'http://localhost:3000',
  INDIGO_CONTENT_MODE: 'development',
  NODE_ENV: 'test',
}

describe('server configuration', () => {
  it('accepts loopback HTTP for local development', () => {
    expect(parseServerConfig(validInput)).toMatchObject({
      appOrigin: 'http://localhost:3000',
      secureCookies: false,
      contentMode: 'development',
      databasePoolMax: 10,
    })
  })

  it.each([6, 10, 64])('accepts database pool budget %i', (databasePoolMax) => {
    expect(
      parseServerConfig({
        ...validInput,
        INDIGO_DATABASE_POOL_MAX: String(databasePoolMax),
      }).databasePoolMax,
    ).toBe(databasePoolMax)
  })

  it.each([
    '',
    '5',
    '65',
    '10.5',
    'not-a-number',
  ])('rejects invalid database pool budget %j', (databasePoolMax) => {
    expect(() =>
      parseServerConfig({
        ...validInput,
        INDIGO_DATABASE_POOL_MAX: databasePoolMax,
      }),
    ).toThrow(InvalidServerConfigurationError)
  })

  it('infers a development tooling mode when development content is explicit', () => {
    const { NODE_ENV: _nodeEnv, ...withoutNodeEnv } = validInput
    expect(parseServerConfig(withoutNodeEnv).nodeEnv).toBe('development')
  })

  it('requires HTTPS for a non-loopback origin', () => {
    expect(() =>
      parseServerConfig({
        ...validInput,
        BETTER_AUTH_URL: 'http://training.home.example',
      }),
    ).toThrow(InvalidServerConfigurationError)
  })

  it('marks HTTPS cookies secure', () => {
    expect(
      parseServerConfig({
        ...validInput,
        BETTER_AUTH_URL: 'https://training.home.example',
      }).secureCookies,
    ).toBe(true)
  })

  it('never accepts a short authentication secret', () => {
    expect(() =>
      parseServerConfig({ ...validInput, BETTER_AUTH_SECRET: 'too-short' }),
    ).toThrow(InvalidServerConfigurationError)
  })

  it('never enables unreviewed development content in a production process', () => {
    expect(() =>
      parseServerConfig({
        ...validInput,
        NODE_ENV: 'production',
        INDIGO_CONTENT_MODE: 'development',
      }),
    ).toThrow(InvalidServerConfigurationError)
  })
})
