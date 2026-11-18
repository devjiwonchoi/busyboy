import { join } from "node:path";

import { build } from "esbuild";

const root = join(import.meta.dirname, "..");

await build({
  entryPoints: {
    main: join(root, "main.ts"),
    // why: Sandboxed preload scripts cannot require other files, so preload is bundled on its own.
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
