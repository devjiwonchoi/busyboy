import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const server = join(import.meta.dirname, "..", ".next", "standalone", "apps", "web", "server.js");
if (!existsSync(server)) {
  throw new Error("No .next/standalone/apps/web/server.js. Run `pnpm build` first.");
}

process.env.HOSTNAME = "127.0.0.1";
process.env.PORT ??= "3000";

await import(pathToFileURL(server).href);
