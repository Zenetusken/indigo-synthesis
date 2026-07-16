import type { UnitOfWorkRequest } from '@/application/coordination'
import type {
  PrelockedSessionLease,
  PrelockedSessionOperation,
} from '@/application/coordination/prelocked-session'
import { getDatabaseRuntime } from '@/platform/db/runtime-registry'
import type { PlatformMutationAuthorityScope } from './mutation-authority'
import {
  PostgresUnitOfWork,
  type PostgresUnitOfWorkOptions,
} from './postgres-unit-of-work'
import {
  prelockedOperationForRequest,
  resolvePlatformPrelockedSession,
} from './prelocked-session'

export type RuntimeGatewayContextFactory<ReadGateways, WriteGateways> =
  PostgresUnitOfWorkOptions<ReadGateways, WriteGateways>['createGatewayContext']

/**
 * Schema-blind production wiring for the PostgreSQL UnitOfWork adapter. Product composition
 * supplies only its gateway binder; Platform retains ordinary checkout and sealed-lease resolution.
 */
export function createRuntimePostgresUnitOfWork<
  ReadGateways,
  WriteGateways extends ReadGateways,
>(
  createGatewayContext: RuntimeGatewayContextFactory<ReadGateways, WriteGateways>,
): PostgresUnitOfWork<ReadGateways, WriteGateways> {
  return new PostgresUnitOfWork({
    acquireOrdinary: (options) => getDatabaseRuntime().acquireOrdinary(options),
    resolvePrelockedSession: (
      lease: PrelockedSessionLease<PrelockedSessionOperation>,
      request: UnitOfWorkRequest,
      authorityScope: PlatformMutationAuthorityScope | null,
    ) =>
      resolvePlatformPrelockedSession(
        lease,
        prelockedOperationForRequest(request),
        authorityScope,
      ),
    createGatewayContext,
  })
}
