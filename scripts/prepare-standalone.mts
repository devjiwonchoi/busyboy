// why: output: 'standalone' omits static assets, and tracing misses native binaries. Windows gets pnpm siblings copied inside each package.
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { installServerPackages } from "./install-server-packages.mts";

const root = join(import.meta.dirname, "..");
const standalone = join(root, ".next", "standalone");
const assetsOnly = process.argv.includes("--assets-only");

if (!existsSync(join(standalone, "server.js"))) {
  throw new Error("No .next/standalone/server.js. Run `next build` first.");
}

const copies = [
  [join(root, ".next", "static"), join(standalone, ".next", "static")],
  [join(root, "public"), join(standalone, "public")],
] as const;

for (const [from, to] of copies) {
  if (!existsSync(from)) continue;
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}

if (!assetsOnly) installServerPackages(standalone, process.platform, process.arch);
