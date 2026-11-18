import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";

import { serverExternalPackages } from "../../web/lib/server-external-packages.ts";
import { standaloneAppDir, standaloneServerPath } from "../standalone-server.ts";
import { assertServerResolves } from "./check-server-resolution.mts";

const nativeRoot = join(import.meta.dirname, "..");
const repoRoot = join(nativeRoot, "..", "..");
const args = process.argv.slice(2);
const standaloneFlag = args.indexOf("--standalone");
const standaloneArg =
  standaloneFlag === -1
    ? join(repoRoot, "apps", "web", ".next", "standalone")
    : args[standaloneFlag + 1];
const windows = args.includes("--windows") || process.platform === "win32";
const packages = ["react", "react-dom", "next", ...serverExternalPackages];

function fail(message: string): never {
  console.error(`::error::${message}`);
  throw new Error(message);
}

function countSymlinks(dir: string): number {
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) count += 1;
      else if (entry.isDirectory()) stack.push(join(current, entry.name));
    }
  }
  return count;
}

if (!standaloneArg) fail("--standalone needs the standalone server directory.");
const standalone = standaloneArg;

const appDir = standaloneAppDir(standalone);
if (!existsSync(standaloneServerPath(standalone)))
  fail("The app bundle has no .next/standalone/apps/web/server.js.");
if (!existsSync(join(nativeRoot, "dist-electron", "main.cjs")))
  fail("The app bundle has no apps/native/dist-electron/main.cjs.");

const symlinks = countSymlinks(standalone);
if (windows && symlinks > 0) fail("The Windows app bundle still contains symlinks.");
if (!windows && symlinks < 1)
  fail("The app bundle has no symlinks. The standalone server would not start.");

const standaloneRoot = realpathSync(standalone);

function assertInside(dir: string, name: string) {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) fail(`The app bundle's ${name} has no package.json.`);
  const manifest = realpathSync(manifestPath);
  const rel = relative(standaloneRoot, manifest);
  if (rel.startsWith("..") || isAbsolute(rel))
    fail(`${name} resolved outside the app bundle (${manifest}).`);
  let parsed: { name?: string };
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
  } catch (error) {
    fail(
      `The app bundle's ${name} package.json cannot be read. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed.name !== name)
    fail(`The app bundle resolved ${name} to ${parsed.name ?? "a package with no name"}.`);
}

const nextDir = join(appDir, "node_modules", "next");
if (!existsSync(nextDir)) fail("The app bundle has no next.");
assertInside(nextDir, "next");
const nextReal = realpathSync(nextDir);
for (const name of ["react", "react-dom"]) {
  const sibling = join(nextReal, "..", name);
  const nested = join(nextReal, "node_modules", name);
  const dir = existsSync(sibling) ? sibling : nested;
  if (!existsSync(dir)) fail(`The app bundle has no ${name}.`);
  assertInside(dir, name);
}
for (const name of serverExternalPackages) {
  const leaf = basename(name);
  const aliasHash = new RegExp(`^${leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[0-9a-f]+$`);
  const candidates = [join(appDir, "node_modules", name), join(standalone, "node_modules", name)];
  const aliasParent = name.startsWith("@")
    ? join(appDir, ".next", "node_modules", name.slice(0, name.indexOf("/")))
    : join(appDir, ".next", "node_modules");
  if (existsSync(aliasParent)) {
    for (const entry of readdirSync(aliasParent)) {
      if (entry === leaf || aliasHash.test(entry)) candidates.push(join(aliasParent, entry));
    }
  }
  const present = candidates.filter((dir) => existsSync(dir));
  if (present.length === 0) fail(`The app bundle has no ${name}.`);
  for (const dir of present) assertInside(dir, name);
}

try {
  assertServerResolves(appDir, standalone);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

console.log(`[check-shared-bundle] Resolved ${packages.join(", ")} from the standalone server.`);
