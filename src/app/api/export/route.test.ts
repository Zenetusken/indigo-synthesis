import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from './route'

const routeMocks = vi.hoisted(() => ({
  capture: vi.fn(),
  create: vi.fn(),
  command: Object.freeze({}),
}))

vi.mock('@/modules/identity/server/subject-export-command', () => ({
  captureSubjectExportCommand: routeMocks.capture,
}))
vi.mock('@/composition/data-portability-subject-export', () => ({
  getProductionDataPortabilitySubjectExportPort: () => ({
    create: routeMocks.create,
  }),
}))

function request(): Request {
  return new Request('https://training.example.test/api/export', {
    headers: { cookie: 'signed-cookie' },
  })
}

describe('GET /api/export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-16T12:00:00.000Z'))
    routeMocks.capture.mockResolvedValue({
      kind: 'captured',
      command: routeMocks.command,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the complete archive with the preserved download hardening headers', async () => {
    const archive = {
      manifest: { schemaVersion: '1.6.0-development', subjectUserId: 'actor-1' },
      identity: { id: 'actor-1' },
    }
    routeMocks.create.mockResolvedValue({ kind: 'exported', archive })
    const exportRequest = request()

    const response = await GET(exportRequest)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="indigo-synthesis-export-2026-07-16.json"',
    )
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    await expect(response.json()).resolves.toEqual(archive)
    expect(routeMocks.create).toHaveBeenCalledWith(routeMocks.command, {
      signal: exportRequest.signal,
    })
  })

  it.each([
    ['capture rejection', 'capture-rejected'],
    ['transactional staleness', 'stale'],
  ] as const)('uses the same 401 response for %s', async (_label, state) => {
    if (state === 'capture-rejected') {
      routeMocks.capture.mockResolvedValue({ kind: 'rejected' })
    } else {
      routeMocks.create.mockResolvedValue({ kind: 'stale' })
    }

    const response = await GET(request())

    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      error: 'Authentication required.',
    })
    if (state === 'capture-rejected') {
      expect(routeMocks.create).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['capture failure', 'capture-error'],
    ['capture query or port failure', 'port-error'],
    ['bounded runtime failure', 'unavailable'],
  ] as const)('returns one retryable 503 for %s', async (_label, state) => {
    if (state === 'capture-error') {
      routeMocks.capture.mockRejectedValue(new Error('database unavailable'))
    } else if (state === 'port-error') {
      routeMocks.create.mockRejectedValue(new Error('database connection lost'))
    } else {
      routeMocks.create.mockResolvedValue({ kind: 'unavailable' })
    }

    const response = await GET(request())

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('retry-after')).toBe('5')
    await expect(response.json()).resolves.toEqual({
      error: 'Export is temporarily unavailable. Please try again.',
    })
    if (state === 'capture-error') {
      expect(routeMocks.create).not.toHaveBeenCalled()
    }
  })

  it('returns no partial archive for an invalid subject graph', async () => {
    routeMocks.create.mockResolvedValue({ kind: 'invalid' })

    const response = await GET(request())

    expect(response.status).toBe(500)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      error: 'Export could not be generated.',
    })
  })
})
