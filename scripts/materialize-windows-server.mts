// why: pnpm siblings only resolve through the package symlink, and Windows tar cannot create those links.
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

function siblings(packageReal: string): Array<[string, string]> {
  const nodeModules = dirname(packageReal);
  if (basename(nodeModules) !== "node_modules") return [];
  const deps: Array<[string, string]> = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = join(nodeModules, entry.name);
    if (entry.name.startsWith("@")) {
      let children: string[];
      try {
        children = readdirSync(entryPath);
      } catch {
        continue;
      }
      for (const child of children)
        deps.push([`${entry.name}/${child}`, realpathSync(join(entryPath, child))]);
    } else {
      deps.push([entry.name, realpathSync(entryPath)]);
    }
  }
  return deps;
}

// why: `stack` is the packages currently being nested. A dependency cycle stops
// why: there; Node then finds the earlier copy by walking up from the inner file.
function placePackage(packageReal: string, dest: string, stack: Set<string>) {
  if (stack.has(packageReal)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(packageReal, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const from = join(packageReal, entry.name);
    const to = join(dest, entry.name);
    if (entry.isSymbolicLink() || entry.isDirectory())
      cpSync(from, to, { recursive: true, dereference: true });
    else if (entry.isFile()) copyFileSync(from, to);
  }
  const nested = new Set(stack);
  nested.add(packageReal);
  for (const [name, depReal] of siblings(packageReal)) {
    if (depReal === packageReal || !statSync(depReal).isDirectory()) continue;
    placePackage(depReal, join(dest, "node_modules", name), nested);
  }
}

function copyEntry(src: string, dest: string) {
  const listed = lstatSync(src);
  if (listed.isSymbolicLink()) {
    const real = realpathSync(src);
    if (statSync(real).isDirectory() && existsSync(join(real, "package.json"))) {
      placePackage(real, dest, new Set());
      return;
    }
    if (statSync(real).isDirectory()) {
      mkdirSync(dest, { recursive: true });
      for (const name of readdirSync(real)) copyEntry(join(real, name), join(dest, name));
      return;
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(real, dest);
    return;
  }
  if (listed.isDirectory()) {
    if (basename(src) === ".pnpm" && basename(dirname(src)) === "node_modules") return;
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) copyEntry(join(src, name), join(dest, name));
    return;
  }
  if (listed.isFile()) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

function symlinkPaths(dir: string): string[] {
  const found: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) found.push(path);
      else if (entry.isDirectory()) stack.push(path);
    }
  }
  return found;
}

export function materializeWindowsServer(src: string, dest: string) {
  rmSync(dest, { recursive: true, force: true });
  copyEntry(src, dest);
  const links = symlinkPaths(dest);
  if (links.length > 0) {
    throw new Error(`The Windows server still contains symlinks:\n${links.join("\n")}`);
  }
}
