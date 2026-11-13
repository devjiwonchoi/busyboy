import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  cacheComponents: true,
  // Next warns when Cache Components is on without this; new apps should enable both.
  partialPrefetching: true,
  // The desktop app runs .next/standalone/server.js inside Electron.
  output: 'standalone',
}

export default nextConfig
