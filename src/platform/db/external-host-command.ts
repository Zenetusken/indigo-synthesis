import type { PrelockedSessionPort } from '@/application/coordination'
import {
  createPlatformPrelockedSessionPort,
  withPlatformExternalHostConnection,
} from '@/platform/application-coordination/prelocked-session'
import {
  type ExternalHostOneShotOptions,
  type ExternalHostOneShotQuery,
  withExternalHostClientOwner,
} from './external-host-one-shot'

export type ExternalHostCaptureQuery = ExternalHostOneShotQuery

/**
 * Owns one dedicated PostgreSQL session from pre-queue capture through lease cleanup. The capture
 * query view is revoked before the nominal prelocked-session port is exposed, so host composition
 * cannot retain a raw connection or instantiate an application pool.
 */
export async function withExternalHostCommand<Capture, Result>(
  options: ExternalHostOneShotOptions,
  capture: (query: ExternalHostCaptureQuery) => Promise<Capture>,
  run: (captured: Capture, prelockedSessions: PrelockedSessionPort) => Promise<Result>,
): Promise<Result> {
  return withExternalHostClientOwner(options, capture, (captured, owner) =>
    withPlatformExternalHostConnection(
      {
        hostInvocationId: owner.hostInvocationId,
        client: owner.client,
        // The raw owner already bounds close. Keep the platform fail-safe outside that deadline
        // so both layers observe the same cached close rejection instead of racing two timers.
        closeTimeoutMs: owner.closeTimeoutMs + 1_000,
        close: () => owner.close(),
        forceDestroy: () => owner.forceDestroy(),
      },
      (externalHostConnection) =>
        run(captured, createPlatformPrelockedSessionPort({ externalHostConnection })),
    ),
  )
}
