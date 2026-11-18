import { resolve } from "node:path";

const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

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
