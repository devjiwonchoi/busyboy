import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

// One identity for a path on this machine. macOS and Windows compare folders
// without regard to case, Windows accepts both separators, and a trailing
// slash is not a different folder. A bare `C:` is the current directory on
// that drive, not `C:\`.

const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32'

/** `~` or `~/…`, and on Windows `~\…` too. `~user` is someone else's home and is left alone. */
const HOME_PREFIX = process.platform === 'win32' ? /^(?:~|\$HOME|\$\{HOME\})(?=$|[/\\])/ : /^(?:~|\$HOME|\$\{HOME\})(?=$|\/)/

/** Drops the `\\?\` and `\\?\UNC\` prefixes Windows uses for the same file. */
function stripWindowsPrefix(path: string) {
  if (process.platform !== 'win32') return path
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`
  if (path.startsWith('\\\\?\\')) return path.slice('\\\\?\\'.length)
  return path
}

/**
 * Stable identity of a path: separators, a trailing slash, a `\\?\` prefix,
 * and (on macOS and Windows) case do not make a second path.
 */
export function pathKey(path: string) {
  // Compared, never opened. Without the ignore comment Turbopack traces the whole project.
  const resolved = resolve(/*turbopackIgnore: true*/ stripWindowsPrefix(path.trim()))
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved
}

/** Whether two paths name the same file or folder on this machine. */
export function samePath(a: string, b: string) {
  return pathKey(a) === pathKey(b)
}

/** Whether `child` is `parent` or a file inside it. `..secret` is inside; `../secret` is not. */
export function containsPath(parent: string, child: string) {
  const inside = relative(/*turbopackIgnore: true*/ pathKey(parent), pathKey(child))
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !inside.startsWith('../') && !isAbsolute(inside))
}

/** File and folder names, compared the way this machine's disk compares them. */
export function sameEntryName(a: string, b: string) {
  return CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** `~`, `~/rest`, and on Windows `~\rest`, as a folder path. Anything else is returned unchanged. */
export function expandHome(path: string) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))) return join(/*turbopackIgnore: true*/ homedir(), path.slice(2))
  return path
}

/**
 * Expands a leading `~`, `$HOME`, or `${HOME}` the way the shell does, then
 * resolves anything else from `cwd`. On Windows `~\` is a home path too.
 */
export function expandShellPath(path: string, cwd: string) {
  const match = HOME_PREFIX.exec(path)
  if (!match) return resolve(/*turbopackIgnore: true*/ cwd, path)
  const rest = path.slice(match[0].length)
  return rest === '' ? homedir() : join(/*turbopackIgnore: true*/ homedir(), rest.slice(1))
}

/** Whether `path` begins with a home shortcut (`~`, `~/`, `$HOME`, `${HOME}`). */
export function isShellHome(path: string) {
  return HOME_PREFIX.test(path)
}

/**
 * Git reads `\` as an escape in `--git-dir=` and `--work-tree=`. Forward
 * slashes name the same folder on Windows and are unchanged everywhere else.
 */
export function gitPath(path: string) {
  return process.platform === 'win32' ? path.replaceAll('\\', '/') : path
}
