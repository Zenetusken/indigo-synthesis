import type { SupervisorState } from './restart-supervisor'
import {
  e2eSupervisorRestartPath,
  e2eSupervisorStatePath,
  e2eSupervisorTokenEnvironment,
  e2eSupervisorUrl,
} from './supervisor-contract'

function supervisorToken(): string {
  const token = process.env[e2eSupervisorTokenEnvironment]
  if (!token) throw new Error(`${e2eSupervisorTokenEnvironment} is required.`)
  return token
}

function isSupervisorState(value: unknown): value is SupervisorState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<SupervisorState>
  return (
    ['stopped', 'starting', 'ready', 'stopping'].includes(state.phase ?? '') &&
    Number.isSafeInteger(state.generation) &&
    (state.pid === null || (Number.isSafeInteger(state.pid) && Number(state.pid) > 0))
  )
}

async function requestSupervisor(
  path: string,
  method: 'GET' | 'POST',
): Promise<SupervisorState> {
  const response = await fetch(`${e2eSupervisorUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${supervisorToken()}` },
    signal: AbortSignal.timeout(130_000),
  })
  if (!response.ok) {
    throw new Error(`E2E supervisor ${method} ${path} failed with ${response.status}.`)
  }

  const state: unknown = await response.json()
  if (!isSupervisorState(state)) {
    throw new Error('The E2E supervisor returned an invalid state document.')
  }
  return state
}

export function readE2eSupervisorState(): Promise<SupervisorState> {
  return requestSupervisor(e2eSupervisorStatePath, 'GET')
}

export function restartE2eApplication(): Promise<SupervisorState> {
  return requestSupervisor(e2eSupervisorRestartPath, 'POST')
}
