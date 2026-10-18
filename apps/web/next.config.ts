import type { NextConfig } from "next";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";
import packageJson from "./package.json" with { type: "json" };
import { fileURLToPath } from "node:url";

const repoEnv = loadRepoEnv();
const config: NextConfig = {
  agentRules: false,
  // Static assets use Electron's existing proxy; only HMR reaches loopback directly.
  allowedDevOrigins: ["app", "127.0.0.1", "localhost"],
  images: { disableStaticImages: true },
  webpack(config, { dev, isServer, webpack }) {
    // Match Vite's existing OXC compiler; Babel exceeds this app's dev memory budget.
    if (!isServer) {
      config.module.rules.push({
        test: /\.[jt]sx?$/,
        include: fileURLToPath(new URL("./src", import.meta.url)),
        enforce: "pre",
        use: fileURLToPath(new URL("./next-react-compiler-loader.mjs", import.meta.url)),
      });
    }
    if (dev) {
      // Next 16 derives HMR's prefix from pathname alone, losing the loopback host.
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /\/next\/dist\/client\/dev\/hot-reloader\/get-socket-url\.js$/,
          fileURLToPath(new URL("./src/next-dev-socket.ts", import.meta.url)),
        ),
      );
    }
    // Only public UI configuration is compiled into the browser, matching Vite.
    config.plugins.push(
      new webpack.DefinePlugin({
        "import.meta.env": JSON.stringify({
          DEV: dev,
          PROD: !dev,
          BASE_URL: "/",
          MODE: dev ? "development" : "production",
          APP_VERSION: process.env.APP_VERSION ?? packageJson.version,
          VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL ?? "",
          VITE_HTTP_URL: process.env.VITE_HTTP_URL ?? "",
          VITE_WS_URL: process.env.VITE_WS_URL ?? "",
          VITE_HOSTED_APP_URL: repoEnv.VITE_HOSTED_APP_URL ?? "",
          VITE_HOSTED_APP_CHANNEL: repoEnv.VITE_HOSTED_APP_CHANNEL ?? "",
          VITE_CLERK_PUBLISHABLE_KEY: repoEnv.VITE_CLERK_PUBLISHABLE_KEY ?? "",
          VITE_CLERK_JWT_TEMPLATE: repoEnv.VITE_CLERK_JWT_TEMPLATE ?? "",
          VITE_CLERK_CLI_OAUTH_CLIENT_ID: repoEnv.VITE_CLERK_CLI_OAUTH_CLIENT_ID ?? "",
          VITE_T3CODE_RELAY_URL: repoEnv.VITE_T3CODE_RELAY_URL ?? "",
          VITE_RELAY_OTLP_TRACES_URL: repoEnv.VITE_RELAY_OTLP_TRACES_URL ?? "",
          VITE_RELAY_OTLP_TRACES_DATASET: repoEnv.VITE_RELAY_OTLP_TRACES_DATASET ?? "",
          VITE_RELAY_OTLP_TRACES_TOKEN: repoEnv.VITE_RELAY_OTLP_TRACES_TOKEN ?? "",
        }),
      }),
    );

    // Keep the existing raw and URL asset imports usable by both development paths.
    config.module.rules.push(
      { resourceQuery: /\braw\b/, type: "asset/source" },
      {
        resourceQuery: /\burl\b/,
        type: "asset/resource",
        generator: { filename: "static/media/[name].[contenthash][ext]" },
      },
      {
        test: /\.(?:wasm|woff2?|ttf|mp3|glb|png|jpe?g|svg|ico|webp|avif)$/i,
        resourceQuery: { not: [/\braw\b/] },
        type: "asset/resource",
        generator: { filename: "static/media/[name].[contenthash][ext]" },
      },
    );
    return config;
  },
};

export default config;
