import { readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { createNextProcessLifecycle } from './next-process'
import {
  isAuthorizedSupervisorRequest,
  RestartSupervisor,
  type SupervisorState,
} from './restart-supervisor'
import {
  e2eApplicationHost,
  e2eApplicationPort,
  e2eApplicationUrl,
  e2eNextDistDir,
  e2eSupervisorHost,
  e2eSupervisorPort,
  e2eSupervisorRestartPath,
  e2eSupervisorStatePath,
  e2eSupervisorTokenEnvironment,
  e2eSupervisorUrl,
} from './supervisor-contract'

function writeJson(
  response: ServerResponse,
  status: number,
  body: SupervisorState | { readonly error: string },
): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(body))
}

function authorizationHeader(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization
  return Array.isArray(header) ? header[0] : header
}

function logState(event: string, state: SupervisorState): void {
  process.stdout.write(
    `[e2e-supervisor] ${event} generation=${state.generation} pid=${state.pid ?? 'none'} phase=${state.phase}\n`,
  )
}

async function main(): Promise<void> {
  const token = process.env[e2eSupervisorTokenEnvironment]
  if (!token || token.length < 32) {
    throw new Error(
      `${e2eSupervisorTokenEnvironment} must contain at least 32 characters.`,
    )
  }

  const projectRoot = resolve(import.meta.dirname, '../../..')
  const nextEnvironmentDeclaration = resolve(projectRoot, 'next-env.d.ts')
  const originalNextEnvironmentDeclaration = readFileSync(nextEnvironmentDeclaration)
  const restoreNextEnvironmentDeclaration = (): void => {
    const current = readFileSync(nextEnvironmentDeclaration)
    if (
      !current.equals(originalNextEnvironmentDeclaration) &&
      current.includes(`./${e2eNextDistDir}/`)
    ) {
      writeFileSync(nextEnvironmentDeclaration, originalNextEnvironmentDeclaration)
    }
  }
  const supervisor = new RestartSupervisor(
    createNextProcessLifecycle({
      applicationUrl: e2eApplicationUrl,
      distDir: e2eNextDistDir,
      host: e2eApplicationHost,
      port: e2eApplicationPort,
      projectRoot,
      readinessTimeoutMs: 120_000,
      shutdownTimeoutMs: 8_000,
    }),
  )

  const controlServer = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        if (
          !isAuthorizedSupervisorRequest(
            {
              remoteAddress: request.socket.remoteAddress,
              authorization: authorizationHeader(request),
            },
            token,
          )
        ) {
          writeJson(response, 401, { error: 'Supervisor authorization required.' })
          return
        }

        const path = new URL(request.url ?? '/', e2eSupervisorUrl).pathname
        if (path === e2eSupervisorStatePath && request.method === 'GET') {
          writeJson(response, 200, supervisor.state())
          return
        }
        if (path === e2eSupervisorRestartPath && request.method === 'POST') {
          const state = await supervisor.restart()
          logState('restarted', state)
          writeJson(response, 200, state)
          return
        }

        writeJson(response, 404, { error: 'Supervisor route not found.' })
      })().catch((error: unknown) => {
        process.stderr.write(
          `[e2e-supervisor] control failure: ${error instanceof Error ? error.message : 'unknown error'}\n`,
        )
        if (!response.headersSent) {
          writeJson(response, 500, { error: 'Supervisor operation failed.' })
        } else {
          response.end()
        }
      })
    },
  )

  await new Promise<void>((resolveListen, rejectListen) => {
    controlServer.once('error', rejectListen)
    controlServer.listen(e2eSupervisorPort, e2eSupervisorHost, () => {
      controlServer.off('error', rejectListen)
      resolveListen()
    })
  })
  process.stdout.write(`[e2e-supervisor] control=${e2eSupervisorUrl}\n`)

  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    process.stdout.write(`[e2e-supervisor] received ${signal}; stopping\n`)
    controlServer.close()
    controlServer.closeAllConnections()

    const gracefulStop = supervisor.stop()
    const deadline = new Promise<void>((resolveDeadline) =>
      setTimeout(resolveDeadline, 10_000),
    )
    await Promise.race([gracefulStop.then(() => undefined), deadline])
    if (supervisor.state().pid !== null) supervisor.forceStop()
    restoreNextEnvironmentDeclaration()
    process.exit(0)
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => void shutdown(signal))
  }
  process.once('exit', () => {
    supervisor.forceStop()
    restoreNextEnvironmentDeclaration()
  })

  try {
    const state = await supervisor.start()
    logState('ready', state)
  } catch (error) {
    controlServer.close()
    controlServer.closeAllConnections()
    throw error
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[e2e-supervisor] fatal: ${error instanceof Error ? error.stack : 'unknown error'}\n`,
  )
  process.exitCode = 1
})
