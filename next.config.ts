import type { NextConfig } from 'next'

const configuredDistDir = process.env.INDIGO_NEXT_DIST_DIR
if (configuredDistDir && configuredDistDir !== '.next-e2e') {
  throw new Error('INDIGO_NEXT_DIST_DIR only supports the isolated .next-e2e directory.')
}

const nextConfig: NextConfig = {
  distDir: configuredDistDir ?? '.next',
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
}

export default nextConfig
