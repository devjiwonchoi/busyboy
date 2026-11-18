import { join } from "node:path";

// why: Next traces the pnpm workspace from the repo root, so the standalone server keeps that layout.
export function standaloneAppDir(standaloneDir: string): string {
  return join(standaloneDir, "apps", "web");
}

export function standaloneServerPath(standaloneDir: string): string {
  return join(standaloneAppDir(standaloneDir), "server.js");
}
