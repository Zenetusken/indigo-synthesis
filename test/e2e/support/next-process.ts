import { type ChildProcess, spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type { SupervisorChild, SupervisorLifecycle } from './restart-supervisor'

type NextProcessOptions = {
  readonly applicationUrl: string
  readonly distDir: string
  readonly host: string
  readonly port: number
  readonly projectRoot: string
  readonly readinessTimeoutMs: number
  readonly shutdownTimeoutMs: number
}

type NextChild = SupervisorChild & {
  readonly detached: boolean
  readonly process: ChildProcess
}

function childExited(child: NextChild): boolean {
  return child.process.exitCode !== null || child.process.signalCode !== null
}

function signalChild(child: NextChild, signal: NodeJS.Signals): void {
  try {
    if (child.detached) process.kill(-child.pid, signal)
    else child.process.kill(signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

async function waitForExit(child: NextChild, timeoutMs: number): Promise<boolean> {
  if (childExited(child)) return true

  return new Promise((resolveExit) => {
    const exited = () => {
      clearTimeout(timer)
      resolveExit(true)
    }
    const timer = setTimeout(() => {
      child.process.off('exit', exited)
      resolveExit(false)
    }, timeoutMs)
    child.process.once('exit', exited)
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function applicationIsReachable(applicationUrl: string): Promise<boolean> {
  try {
    await fetch(applicationUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(500),
    })
    return true
  } catch {
    return false
  }
}

async function waitForApplicationExit(
  applicationUrl: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await applicationIsReachable(applicationUrl))) return true
    await delay(100)
  }
  return !(await applicationIsReachable(applicationUrl))
}

export function createNextProcessLifecycle(
  options: NextProcessOptions,
): SupervisorLifecycle<NextChild> {
  return {
    spawnChild() {
      const nextBin = resolve(options.projectRoot, 'node_modules/next/dist/bin/next')
      const detached = process.platform !== 'win32'
      const childProcess = spawn(
        process.execPath,
        [nextBin, 'dev', '--hostname', options.host, '--port', String(options.port)],
        {
          cwd: options.projectRoot,
          detached,
          env: {
            ...process.env,
            INDIGO_NEXT_DIST_DIR: options.distDir,
            NEXT_TELEMETRY_DISABLED: '1',
          },
          stdio: 'inherit',
        },
      )

      if (!childProcess.pid) {
        childProcess.kill('SIGKILL')
        throw new Error('Next.js did not expose a child PID to the E2E supervisor.')
      }

      return { pid: childProcess.pid, process: childProcess, detached }
    },

    async waitUntilReady(child) {
      const deadline = Date.now() + options.readinessTimeoutMs

      while (Date.now() < deadline) {
        if (childExited(child)) {
          throw new Error(
            `Next.js generation PID ${child.pid} exited before it became ready.`,
          )
        }

        try {
          const response = await fetch(options.applicationUrl, {
            redirect: 'manual',
            signal: AbortSignal.timeout(1_500),
          })
          if (response.status >= 200 && response.status < 400) return
        } catch {
          // A refused connection is expected while Next.js compiles the first route.
        }

        await delay(250)
      }

      throw new Error(
        `Next.js generation PID ${child.pid} was not ready within ${options.readinessTimeoutMs}ms.`,
      )
    },

    async stopChild(child) {
      signalChild(child, 'SIGTERM')
      if (!(await waitForExit(child, options.shutdownTimeoutMs))) {
        signalChild(child, 'SIGKILL')
        await waitForExit(child, 2_000)
      }

      if (!(await waitForApplicationExit(options.applicationUrl, 2_000))) {
        signalChild(child, 'SIGKILL')
        if (!(await waitForApplicationExit(options.applicationUrl, 2_000))) {
          throw new Error(
            `Next.js generation PID ${child.pid} exited but ${options.applicationUrl} remained reachable.`,
          )
        }
      }
    },

    forceStopChild(child) {
      signalChild(child, 'SIGKILL')
    },
  }
}
