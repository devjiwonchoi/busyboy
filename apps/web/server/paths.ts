import { resolve } from "node:path";

// why: macOS and Windows compare folders without regard to case, and a bare C: is the current directory on that drive.

const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

/*why: * Drops the `\\?\` and `\\?\UNC\` prefixes Windows uses for the same file. */
function stripWindowsPrefix(path: string) {
  if (process.platform !== "win32") return path;
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice("\\\\?\\UNC\\".length)}`;
  if (path.startsWith("\\\\?\\")) return path.slice("\\\\?\\".length);
  return path;
}

// why: Separators, a trailing slash, a \\?\ prefix, and (on macOS and Windows) case do not make a second path.
export function pathKey(path: string) {
  // why: Compared, never opened. Without the ignore comment Turbopack traces the whole project.
  const resolved = resolve(/*turbopackIgnore: true*/ stripWindowsPrefix(path.trim()));
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
}
