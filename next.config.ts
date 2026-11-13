import type { NextConfig } from 'next'
import { serverExternalPackages } from './src/lib/server-external-packages'

const isDev = process.env.NODE_ENV === 'development'

// Pages may load only from the app's own origin. With Cache Components the
// shell is prerendered at build time, and Next's inline bootstrap scripts in
// that HTML cannot carry a per-request nonce (nonces need every page rendered
// dynamically and do not work with Partial Prerendering), so scripts and
// styles allow 'unsafe-inline'. Dev also needs eval for React's debugging and
// a websocket for hot reload, both on the same origin.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

const nextConfig: NextConfig = {
  cacheComponents: true,
  // Next warns when Cache Components is on without this; new apps should enable both.
  partialPrefetching: true,
  // The desktop app runs .next/standalone/server.js inside Electron.
  output: 'standalone',
  // Packages that load files by computed paths, so packaging installs them
  // whole instead of using traced files (see src/lib/server-external-packages.ts).
  serverExternalPackages,
  // 'use cache' already defaults to memory. The cache for ISR, route handlers,
  // fetch, and images defaults to files under .next, inside the packaged app,
  // so it is kept in memory too (see src/lib/memory-cache-handler.mjs).
  cacheHandler: require.resolve('./src/lib/memory-cache-handler.mjs'),
  // Without this, optimized images still go to the file cache under .next.
  images: { customCacheHandler: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ]
  },
}

export default nextConfig
