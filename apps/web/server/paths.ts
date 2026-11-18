import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

const HOME_PREFIX =
  process.platform === "win32"
    ? /^(?:~|\$HOME|\$\{HOME\})(?=$|[/\\])/
    : /^(?:~|\$HOME|\$\{HOME\})(?=$|\/)/;

function stripWindowsPrefix(path: string) {
  if (process.platform !== "win32") return path;
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice("\\\\?\\UNC\\".length)}`;
  if (path.startsWith("\\\\?\\")) return path.slice("\\\\?\\".length);
  return path;
}

export function pathKey(path: string) {
  const resolved = resolve(/*turbopackIgnore: true*/ stripWindowsPrefix(path.trim()));
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
}

export function samePath(a: string, b: string) {
  return pathKey(a) === pathKey(b);
}

export function containsPath(parent: string, child: string) {
  const inside = relative(/*turbopackIgnore: true*/ pathKey(parent), pathKey(child));
  return (
    inside === "" ||
    (inside !== ".." &&
      !inside.startsWith(`..${sep}`) &&
      !inside.startsWith("../") &&
      !isAbsolute(inside))
  );
}

export function sameEntryName(a: string, b: string) {
  return CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function expandHome(path: string) {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\")))
    return join(/*turbopackIgnore: true*/ homedir(), path.slice(2));
  return path;
}

export function expandShellPath(path: string, cwd: string) {
  const match = HOME_PREFIX.exec(path);
  if (!match) return resolve(/*turbopackIgnore: true*/ cwd, path);
  const rest = path.slice(match[0].length);
  return rest === "" ? homedir() : join(/*turbopackIgnore: true*/ homedir(), rest.slice(1));
}

export function isShellHome(path: string) {
  return HOME_PREFIX.test(path);
}

export function gitPath(path: string) {
  return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
}
