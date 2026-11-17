import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const entry = process.argv[2];
if (!entry) {
  console.error("Usage: node scripts/run-check.mts <script>");
  process.exit(1);
}

const root = join(import.meta.dirname, "..");
const directory = mkdtempSync(join(tmpdir(), "busyboy-check-"));
const outfile = join(directory, "check.mjs");

await build({
  absWorkingDir: root,
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  target: "node22",
  logLevel: "silent",
  define: {
    "process.env.BUSYBOY_CHECK_ROOT": JSON.stringify(root),
  },
});

try {
  await import(pathToFileURL(outfile).href);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
