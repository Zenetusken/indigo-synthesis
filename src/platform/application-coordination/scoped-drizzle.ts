import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { ScopedTransactionClient } from './postgres-unit-of-work'

function invalidDrizzleQuery(): TypeError {
  return new TypeError('Scoped Drizzle emitted an unsupported query contract.')
}

function exactDataDescriptor(
  descriptors: PropertyDescriptorMap,
  key: PropertyKey,
): PropertyDescriptor {
  const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor | undefined
  if (
    !descriptor ||
    !('value' in descriptor) ||
    descriptor.configurable !== true ||
    descriptor.enumerable !== true ||
    descriptor.writable !== true
  ) {
    throw invalidDrizzleQuery()
  }
  return descriptor
}

function exactOwnKeys(
  descriptors: PropertyDescriptorMap,
  expected: readonly string[],
): void {
  const expectedKeys = new Set<PropertyKey>(expected)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
    throw invalidDrizzleQuery()
  }
}

function validateTypesConfig(value: unknown): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalidDrizzleQuery()
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  exactOwnKeys(descriptors, ['getTypeParser'])
  if (typeof exactDataDescriptor(descriptors, 'getTypeParser').value !== 'function') {
    throw invalidDrizzleQuery()
  }
}

function dispatchDrizzleQuery(
  scoped: ScopedTransactionClient,
  args: readonly unknown[],
): Promise<unknown> {
  try {
    if (args.length !== 2) throw invalidDrizzleQuery()
    const [config, parameters] = args
    if (
      config === null ||
      typeof config !== 'object' ||
      Object.getPrototypeOf(config) !== Object.prototype ||
      !Array.isArray(parameters)
    ) {
      throw invalidDrizzleQuery()
    }

    const descriptors = Object.getOwnPropertyDescriptors(config)
    const rowModeDescriptor = Reflect.get(descriptors, 'rowMode') as
      | PropertyDescriptor
      | undefined
    exactOwnKeys(
      descriptors,
      rowModeDescriptor
        ? ['name', 'rowMode', 'text', 'types']
        : ['name', 'text', 'types'],
    )
    if (exactDataDescriptor(descriptors, 'name').value !== undefined) {
      throw invalidDrizzleQuery()
    }
    const text = exactDataDescriptor(descriptors, 'text').value
    if (typeof text !== 'string') throw invalidDrizzleQuery()
    validateTypesConfig(exactDataDescriptor(descriptors, 'types').value)

    if (rowModeDescriptor) {
      if (exactDataDescriptor(descriptors, 'rowMode').value !== 'array') {
        throw invalidDrizzleQuery()
      }
      return scoped.queryArray(text, parameters)
    }
    return scoped.query(text, parameters)
  } catch (error) {
    return Promise.reject(error)
  }
}

/**
 * Binds Drizzle's reviewed node-postgres query builder to one already-tracked UoW client.
 * The explicit return type hides Drizzle's runtime `$client`, and this module never exposes the
 * local compatibility shim or accepts a schema/raw connection.
 */
export function createScopedDrizzleDatabase(
  scoped: ScopedTransactionClient,
): NodePgDatabase {
  const queryOnlyClient = Object.freeze({
    query: (...args: readonly unknown[]) => dispatchDrizzleQuery(scoped, args),
  })
  // Drizzle's public type requires a complete Pool/Client, while the pinned runtime calls only
  // query(). The compatibility object stays local; the scoped client is never cast or exposed.
  return drizzle(queryOnlyClient as never)
}
