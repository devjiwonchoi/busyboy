import type { NextConfig } from 'next'

// node-pty is kept external by default, but it loads its native binaries by a
// computed path that file tracing cannot follow. List them (without debug
// symbols) so the standalone server can start shells.
const nodePty = './node_modules/node-pty/prebuilds'
const nodePtyBinaries = [
  `${nodePty}/*/*.node`,
  `${nodePty}/*/*.dll`,
  `${nodePty}/*/*.exe`,
  `${nodePty}/*/spawn-helper`,
  `${nodePty}/*/conpty/*`,
]

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  output: 'standalone',
  outputFileTracingIncludes: { '/api/terminal': nodePtyBinaries },
}

export default nextConfig
