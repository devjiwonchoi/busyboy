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

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  output: 'standalone',
  outputFileTracingIncludes: { '/api/terminal': nodePtyRuntimeFiles },
}

export default nextConfig
