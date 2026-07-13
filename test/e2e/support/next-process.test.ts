import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from 'vitest'
import { createNextProcessLifecycle } from './next-process'

test('does not declare a Next generation ready until the auth route is warm', async () => {
  const requests: string[] = []
  let authAttempts = 0
  const server = createServer((request, response) => {
    const path = request.url ?? '/'
    requests.push(path)
    if (path === '/') {
      response.writeHead(307, { location: '/sign-in' })
      response.end()
      return
    }
    if (path === '/api/auth/get-session') {
      authAttempts += 1
      response.writeHead(authAttempts === 1 ? 503 : 200, {
        'content-type': 'application/json',
      })
      response.end('null')
      return
    }
    response.writeHead(404)
    response.end()
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })

  try {
    const address = server.address() as AddressInfo
    const lifecycle = createNextProcessLifecycle({
      applicationUrl: `http://127.0.0.1:${address.port}`,
      distDir: '.next-e2e',
      host: '127.0.0.1',
      port: address.port,
      projectRoot: process.cwd(),
      readinessTimeoutMs: 2_000,
      shutdownTimeoutMs: 1_000,
    })

    await lifecycle.waitUntilReady({
      pid: process.pid,
      detached: false,
      process: { exitCode: null, signalCode: null } as ChildProcess,
    })

    expect(requests).toEqual(['/', '/api/auth/get-session', '/', '/api/auth/get-session'])
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(error)
        else resolveClose()
      })
    })
  }
})
