import type { NextConfig } from "next";

import { serverExternalPackages } from "./lib/server-external-packages";

const isDev = process.env.NODE_ENV === "development";

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  cacheComponents: true,
  reactCompiler: true,
  experimental: {
    authInterrupts: true,
    serverActions: { bodySizeLimit: "12mb" },
    turbopackRustReactCompiler: true,
  },
  partialPrefetching: true,
  output: "standalone",
  outputFileTracingExcludes: {
    "*": [
      ".git",
      ".git/**",
      "release/**",
      "dist-electron/**",
      "electron/**",
      "scripts/**",
      ".github/**",
      "*.md",
    ],
  },
  serverExternalPackages,
  cacheHandler: require.resolve("./lib/memory-cache-handler.mjs"),
  images: { customCacheHandler: true },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
