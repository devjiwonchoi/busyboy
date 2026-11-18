// why: Windows cannot create pnpm's symlinks, so it gets real directories with siblings nested inside.
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { standaloneServerPath } from "../standalone-server.ts";
import { materializeWindowsServer } from "./materialize-windows-server.mts";

const nativeRoot = join(import.meta.dirname, "..");
const repoRoot = join(nativeRoot, "..", "..");
const standaloneRel = join("apps", "web", ".next", "standalone");
const electronRel = join("apps", "native", "dist-electron");
const roots = [join(repoRoot, standaloneRel), join(repoRoot, electronRel)];

if (!existsSync(standaloneServerPath(roots[0]))) {
  throw new Error("No apps/web/.next/standalone/apps/web/server.js. Run `next build` first.");
}
if (!existsSync(join(roots[1], "main.cjs"))) {
  throw new Error("No apps/native/dist-electron/main.cjs. Run `pnpm build:electron` first.");
}

function inside(candidate: string, containers: readonly string[]): boolean {
  return containers.some((container) => {
    const rel = relative(container, candidate);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

// why: A link into the build machine's node_modules works on that runner and
// why: nowhere else. tar -h would also copy the target into the Windows archive.
const realRoots = roots.map((dir) => realpathSync(dir));
const leaks: string[] = [];
for (const dir of roots) {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const link = readlinkSync(path);
        const target = isAbsolute(link) ? link : resolve(dirname(path), link);
        let real = target;
        try {
          if (existsSync(target)) real = realpathSync(target);
        } catch {
          real = target;
        }
        if (!existsSync(target) || !inside(target, realRoots) || !inside(real, realRoots)) {
          leaks.push(`${relative(repoRoot, path)} -> ${link}`);
        }
      } else if (entry.isDirectory()) {
        stack.push(path);
      }
    }
  }
}
if (leaks.length > 0) {
  throw new Error(
    `The app bundle has symlinks that leave the standalone server:\n${leaks.join("\n")}`,
  );
}

function listSymlinks(archive: string): string[] {
  // why: The standalone tree's file list is larger than execFileSync's default buffer.
  const listing = spawnSync("tar", ["-tvf", archive], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listing.error) throw listing.error;
  if (listing.status !== 0) throw new Error(`tar -tvf ${archive} exited ${listing.status}.`);
  return (listing.stdout ?? "").split("\n").filter((line) => line.startsWith("l"));
}

execFileSync("tar", ["--format=posix", "-cf", "desktop-bundle.tar", standaloneRel, electronRel], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (listSymlinks("desktop-bundle.tar").length < 1) {
  throw new Error("The app bundle has no symlinks. The standalone server would not start.");
}

const staging = mkdtempSync(join(tmpdir(), "busyboy-windows-bundle-"));
try {
  const windowsStandalone = join(staging, standaloneRel);
  materializeWindowsServer(join(repoRoot, standaloneRel), windowsStandalone);
  cpSync(join(repoRoot, electronRel), join(staging, electronRel), {
    recursive: true,
    dereference: true,
  });
  execFileSync(process.execPath, ["apps/native/scripts/check-shared-bundle.mts"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  execFileSync(
    process.execPath,
    ["apps/native/scripts/check-shared-bundle.mts", "--windows", "--standalone", windowsStandalone],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );
  execFileSync(
    "tar",
    [
      "--format=posix",
      "-cf",
      join(repoRoot, "desktop-bundle-windows.tar"),
      "-C",
      staging,
      standaloneRel,
      electronRel,
    ],
    { stdio: "inherit" },
  );
} finally {
  rmSync(staging, { recursive: true, force: true });
}
const windowsLinks = listSymlinks("desktop-bundle-windows.tar");
if (windowsLinks.length > 0) {
  throw new Error(`The Windows app bundle still contains symlinks:\n${windowsLinks.join("\n")}`);
}

const macBytes = statSync(join(repoRoot, "desktop-bundle.tar")).size;
const windowsBytes = statSync(join(repoRoot, "desktop-bundle-windows.tar")).size;
console.log(
  `[pack-desktop-bundle] macOS archive ${macBytes} bytes, Windows archive ${windowsBytes} bytes`,
);
