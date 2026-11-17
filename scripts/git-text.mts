import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function gitText(args: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "busyboy-git-"));
  const output = join(directory, "out");
  const fd = openSync(output, "w");
  const result = spawnSync("git", args, { stdio: ["ignore", fd, "pipe"] });
  closeSync(fd);
  const stderr = result.stderr?.toString() ?? "";
  if (result.error || result.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    console.error(stderr.trim() || result.error?.message || `git exited ${result.status}`);
    process.exit(1);
  }
  const text = readFileSync(output, "utf8");
  rmSync(directory, { recursive: true, force: true });
  return text;
}

export function diffFromMergeBase(base: string, diffArgs: string[]): string {
  const probe = spawnSync("git", ["merge-base", base, "HEAD"], { encoding: "utf8" });
  if (probe.status !== 0 || !probe.stdout?.trim()) {
    const detail = probe.stderr?.trim();
    console.error(
      `Cannot find the merge base of ${base} and HEAD. Fetch that base with its history, then compare ${base}...HEAD so commits that exist only on the base are not treated as reversions.${detail ? `\n${detail}` : ""}`,
    );
    process.exit(1);
  }
  return gitText(["diff", ...diffArgs, `${base}...HEAD`]);
}
