import { execFileSync } from "node:child_process";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

execFileSync(
  "pnpm",
  ["install", "--frozen-lockfile", "--prefer-offline", "--reporter=append-only"],
  {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);
