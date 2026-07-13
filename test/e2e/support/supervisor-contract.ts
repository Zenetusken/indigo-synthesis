export function resolveE2ePort(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be an integer port.`)
  }
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`${name} must be between 1024 and 65535.`)
  }
  return port
}

export const e2eApplicationHost = '127.0.0.1'
export const e2eApplicationPort = resolveE2ePort(
  'INDIGO_E2E_APPLICATION_PORT',
  process.env.INDIGO_E2E_APPLICATION_PORT,
  3100,
)
export const e2eApplicationUrl = `http://${e2eApplicationHost}:${e2eApplicationPort}`

export const e2eSupervisorHost = '127.0.0.1'
export const e2eSupervisorPort = resolveE2ePort(
  'INDIGO_E2E_SUPERVISOR_PORT',
  process.env.INDIGO_E2E_SUPERVISOR_PORT,
  3101,
)
if (e2eSupervisorPort === e2eApplicationPort) {
  throw new Error('E2E application and supervisor ports must differ.')
}
export const e2eSupervisorUrl = `http://${e2eSupervisorHost}:${e2eSupervisorPort}`

export const e2eSupervisorStatePath = '/state'
export const e2eSupervisorRestartPath = '/restart'
export const e2eNextDistDir = '.next-e2e'
export const e2eSupervisorTokenEnvironment = 'E2E_SUPERVISOR_TOKEN'
