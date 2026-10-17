// The local server build uses the development favicons from upstream.
export const DEVELOPMENT_ICON_OVERRIDES = [
  {
    sourceRelativePath: "assets/dev/blueprint-web-favicon.ico",
    targetRelativePath: "dist/client/favicon.ico",
  },
  {
    sourceRelativePath: "assets/dev/blueprint-web-favicon-16x16.png",
    targetRelativePath: "dist/client/favicon-16x16.png",
  },
  {
    sourceRelativePath: "assets/dev/blueprint-web-favicon-32x32.png",
    targetRelativePath: "dist/client/favicon-32x32.png",
  },
  {
    sourceRelativePath: "assets/dev/blueprint-web-apple-touch-180.png",
    targetRelativePath: "dist/client/apple-touch-icon.png",
  },
] as const;
