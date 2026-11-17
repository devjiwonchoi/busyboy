import type { NextConfig } from 'next'
import { serverExternalPackages } from './src/lib/server-external-packages'

const isDev = process.env.NODE_ENV === 'development'

// Cache Components prerenders the shell, and Next cannot put a per-request nonce on those inline scripts.
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
  // Four megabytes of image bytes is about five and a half of base64, past the default 1 MB action body.
  experimental: { serverActions: { bodySizeLimit: '12mb' } },
  // Next warns when Cache Components is on without this; new apps should enable both.
  partialPrefetching: true,
  output: 'standalone',
  // File tracing copies a checkout's .git into the standalone server, and codesign cannot sign it.
  outputFileTracingExcludes: {
    '*': ['.git', '.git/**', 'tests/**', 'test-results/**', 'release/**', 'dist-electron/**', 'electron/**', 'scripts/**', '.github/**', '*.md'],
  },
  serverExternalPackages,
  // The file cache writes under .next, inside the signed app bundle.
  cacheHandler: require.resolve('./src/lib/memory-cache-handler.mjs'),
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
