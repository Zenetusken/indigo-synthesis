import { timingSafeEqual } from 'node:crypto'

export type SupervisorPhase = 'stopped' | 'starting' | 'ready' | 'stopping'

export type SupervisorState = {
  readonly phase: SupervisorPhase
  readonly generation: number
  readonly pid: number | null
}

export type SupervisorChild = {
  readonly pid: number
}

export type SupervisorLifecycle<Child extends SupervisorChild> = {
  readonly spawnChild: () => Child
  readonly waitUntilReady: (child: Child) => Promise<void>
  readonly stopChild: (child: Child) => Promise<void>
  readonly forceStopChild: (child: Child) => void
}

type AuthorizationInput = {
  readonly remoteAddress: string | undefined
  readonly authorization: string | undefined
}

function tokensMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function isAuthorizedSupervisorRequest(
  request: AuthorizationInput,
  expectedToken: string,
): boolean {
  if (!isLoopbackAddress(request.remoteAddress)) return false
  const prefix = 'Bearer '
  if (!request.authorization?.startsWith(prefix)) return false
  return tokensMatch(request.authorization.slice(prefix.length), expectedToken)
}

export class RestartSupervisor<Child extends SupervisorChild> {
  private child: Child | null = null
  private generation = 0
  private phase: SupervisorPhase = 'stopped'
  private operation: Promise<void> = Promise.resolve()

  constructor(private readonly lifecycle: SupervisorLifecycle<Child>) {}

  state(): SupervisorState {
    return {
      phase: this.phase,
      generation: this.generation,
      pid: this.child?.pid ?? null,
    }
  }

  start(): Promise<SupervisorState> {
    return this.enqueue(() => this.startNow())
  }

  restart(): Promise<SupervisorState> {
    return this.enqueue(async () => {
      await this.stopNow()
      return this.startNow()
    })
  }

  stop(): Promise<SupervisorState> {
    return this.enqueue(() => this.stopNow())
  }

  forceStop(): SupervisorState {
    const child = this.child
    this.child = null
    this.phase = 'stopped'
    if (child) this.lifecycle.forceStopChild(child)
    return this.state()
  }

  private enqueue(operation: () => Promise<SupervisorState>): Promise<SupervisorState> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async startNow(): Promise<SupervisorState> {
    if (this.child) return this.state()

    const child = this.lifecycle.spawnChild()
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
      this.lifecycle.forceStopChild(child)
      throw new Error('The E2E application child did not report a valid PID.')
    }

    this.child = child
    this.generation += 1
    this.phase = 'starting'

    try {
      await this.lifecycle.waitUntilReady(child)
      if (this.child !== child) {
        throw new Error('The E2E application child changed during readiness.')
      }
      this.phase = 'ready'
      return this.state()
    } catch (error) {
      this.phase = 'stopping'
      try {
        await this.lifecycle.stopChild(child)
      } finally {
        if (this.child === child) this.child = null
        this.phase = 'stopped'
      }
      throw error
    }
  }

  private async stopNow(): Promise<SupervisorState> {
    const child = this.child
    if (!child) {
      this.phase = 'stopped'
      return this.state()
    }

    this.phase = 'stopping'
    try {
      await this.lifecycle.stopChild(child)
    } finally {
      if (this.child === child) this.child = null
      this.phase = 'stopped'
    }
    return this.state()
  }
}
