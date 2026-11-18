import { join } from "node:path";

export function standaloneAppDir(standaloneDir: string): string {
  return join(standaloneDir, "apps", "web");
}

export function standaloneServerPath(standaloneDir: string): string {
  return join(standaloneAppDir(standaloneDir), "server.js");
}
