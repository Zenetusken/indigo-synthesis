/**
 * Compatibility export for the methodology and existing product modules. The canonical
 * JSON/hash primitive is technical shared code so Platform can seal coordination tokens
 * without importing a product module.
 */
export {
  type CanonicalValue,
  canonicalSha256,
  canonicalStringify,
  NonCanonicalValueError,
  sha256,
} from '@/shared/canonical-json'
