import type { NextConfig } from 'next'

// node-pty is kept external by default, but it loads its native binaries and,
// on Windows, its conout worker and console-list agent by computed paths that
// file tracing cannot follow. List them (without debug symbols) so the
// standalone server can start shells. `build/Release` holds a binary compiled
// from source when no prebuild fits.
const nodePty = './node_modules/node-pty'
const nodePtyRuntimeFiles = [
  `${nodePty}/prebuilds/*/*.node`,
  `${nodePty}/prebuilds/*/*.dll`,
  `${nodePty}/prebuilds/*/*.exe`,
  `${nodePty}/prebuilds/*/spawn-helper`,
  `${nodePty}/prebuilds/*/conpty/*`,
  `${nodePty}/build/Release/*.node`,
  `${nodePty}/build/Release/*.dll`,
  `${nodePty}/build/Release/*.exe`,
  `${nodePty}/build/Release/spawn-helper`,
  `${nodePty}/build/Release/conpty/*`,
  `${nodePty}/lib/*.js`,
  `${nodePty}/lib/shared/*.js`,
  `${nodePty}/lib/worker/*.js`,
]

const isDev = process.env.NODE_ENV === 'development'

// Pages may load only from the app's own origin. Next's inline bootstrap
// scripts and styles need 'unsafe-inline' on statically prerendered pages
// (nonces require dynamic rendering); dev also needs eval for React's
// debugging and a websocket for hot reload, both on the same origin.
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
  partialPrefetching: true,
  output: 'standalone',
  outputFileTracingIncludes: { '/api/terminal': nodePtyRuntimeFiles },
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
