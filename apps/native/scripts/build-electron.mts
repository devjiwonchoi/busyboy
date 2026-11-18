import { join } from "node:path";

import { build } from "esbuild";

const root = join(import.meta.dirname, "..");

await build({
  entryPoints: {
    main: join(root, "main.ts"),
    preload: join(root, "preload.ts"),
  },
  outdir: join(root, "dist-electron"),
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: "linked",
  logLevel: "warning",
});
