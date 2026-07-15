import type { NextConfig } from 'next'

const configuredDistDir = process.env.INDIGO_NEXT_DIST_DIR
if (configuredDistDir && configuredDistDir !== '.next-e2e') {
  throw new Error('INDIGO_NEXT_DIST_DIR only supports the isolated .next-e2e directory.')
}

const nextConfig: NextConfig = {
  distDir: configuredDistDir ?? '.next',
  logging: {
    // Server-function diagnostics serialize decoded arguments, which can contain
    // credentials from identity and recovery actions. Keep request timing logs,
    // but never copy action payloads into developer or E2E output.
    serverFunctions: false,
  },
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
}

export default nextConfig
