import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { containsPath, samePath } from '../paths'
import { locateTaskRecords } from '../records/record-location'

// VERIFY.md cites screenshots and traces by the path the skill wrote. The
// markdown view only draws an image or a link when the address is http(s) or
// begins at this site's root, so a file sitting next to the note would be
// dropped. A path that stays inside the task worktree is swapped for a
// same-origin address; anything else is left as written.

const FENCE = /^\s*(```|~~~)/
const LINK = /(!?\[[^\]\n]*\])\((<[^>\n]+>|[^)\s]+)(?:\s+("[^"\n]*"|'[^'\n]*'))?\)/g
const DEFINITION = /^(\[[^\]\n]+\]:\s+)(\S+)/
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const WINDOWS_PATH = /^[a-z]:[\\/]/i
const CODE_SPAN = /`[^`\n]*`/g

/** A screenshot or trace large enough to be a real Playwright trace, and no larger. */
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

const IMAGE_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
}

type ArtifactContext = { taskId: string; recordFolder: string; worktree: string }

export type TaskArtifact = {
  bytes: Buffer
  contentType: string
  /** `inline` for an image the note draws; anything else downloads. */
  inline: boolean
  name: string
}

export function artifactUrl(taskId: string, relativeFile: string) {
  return `/api/task-artifact?${new URLSearchParams({ task: taskId, file: relativeFile }).toString()}`
}

/** A worktree-relative file, or null when `file` leaves the worktree or is not a relative path. */
function safeRelative(file: string) {
  if (!file || file.length > 1000 || file.includes('\0')) return null
  const slash = file.replaceAll('\\', '/')
  if (slash.startsWith('/') || WINDOWS_PATH.test(slash)) return null
  const parts: string[] = []
  for (const part of slash.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') return null
    parts.push(part)
  }
  return parts.length > 0 ? parts.join('/') : null
}

function extensionOf(file: string) {
  const dot = file.lastIndexOf('.')
  return dot === -1 ? '' : file.slice(dot).toLowerCase()
}

/**
 * The address to use for one markdown destination, when it names a file inside
 * the worktree. Relative paths are read from the record folder, where VERIFY.md
 * itself lives. http(s) links are already addresses and stay as written.
 */
function hostedArtifact(destination: string, context: ArtifactContext) {
  const raw = destination.trim()
  if (!raw || raw.startsWith('#') || raw.includes('\0')) return null
  let pathText = raw
  if (/^file:/i.test(raw)) {
    try {
      pathText = fileURLToPath(raw)
    } catch {
      return null
    }
  } else if (!WINDOWS_PATH.test(raw) && SCHEME.test(raw)) {
    return null
  }
  let decoded = pathText
  try {
    decoded = decodeURI(pathText)
  } catch {
    return null
  }
  const cutAt = ['?', '#'].map((mark) => decoded.indexOf(mark)).filter((index) => index >= 0)
  const pathOnly = cutAt.length > 0 ? decoded.slice(0, Math.min(...cutAt)) : decoded
  if (!pathOnly || pathOnly.includes('\0')) return null
  const absolute = isAbsolute(pathOnly) ? pathOnly : resolve(/*turbopackIgnore: true*/ context.recordFolder, pathOnly)
  // Relative paths are next to VERIFY.md, in the record folder. An absolute path may also name a file in the worktree.
  const root = containsPath(context.recordFolder, absolute) && !samePath(context.recordFolder, absolute) ? context.recordFolder : containsPath(context.worktree, absolute) && !samePath(context.worktree, absolute) ? context.worktree : null
  if (!root) return null
  const relativeFile = relative(/*turbopackIgnore: true*/ root, absolute).split(sep).join('/')
  if (!safeRelative(relativeFile)) return null
  return artifactUrl(context.taskId, relativeFile)
}

function rewritePlain(text: string, context: ArtifactContext) {
  LINK.lastIndex = 0
  const linked = text.replace(LINK, (full, label: string, dest: string, title?: string) => {
    const inner = dest.startsWith('<') && dest.endsWith('>') ? dest.slice(1, -1).trim() : dest
    const next = hostedArtifact(inner, context)
    if (!next) return full
    return `${label}(${next}${title ? ` ${title}` : ''})`
  })
  return linked.replace(DEFINITION, (full, prefix: string, dest: string) => {
    const next = hostedArtifact(dest, context)
    return next ? `${prefix}${next}` : full
  })
}

/** VERIFY.md with each local screenshot and trace pointed at a file this app can serve. */
export function linkTaskArtifacts(markdown: string, context: ArtifactContext) {
  let fenced = false
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced
        return line
      }
      if (fenced) return line
      const parts: string[] = []
      let last = 0
      CODE_SPAN.lastIndex = 0
      for (const match of line.matchAll(CODE_SPAN)) {
        const index = match.index ?? 0
        parts.push(rewritePlain(line.slice(last, index), context))
        parts.push(match[0])
        last = index + match[0].length
      }
      parts.push(rewritePlain(line.slice(last), context))
      return parts.join('')
    })
    .join('\n')
}

/**
 * One file a verification note cites, read from the task's record folder, or from
 * the worktree when the path names a file there. A symbolic link is refused.
 * Null when the task or the file is not there.
 */
export async function readTaskArtifact({
  folder,
  taskId,
  file,
}: {
  folder: string
  taskId: string
  file: string
}): Promise<TaskArtifact | 'too-large' | null> {
  const relativeFile = safeRelative(file)
  if (!relativeFile || taskId.length > 500) return null
  const { readTasksAt } = await import('../tasks')
  const task = (await readTasksAt(folder)).find((item) => item.id === taskId)
  if (!task) return null
  const located = await locateTaskRecords(folder, task)
  const roots = [located && 'folder' in located ? located.folder : null, task.worktree].filter((root): root is string => root !== null)
  for (const root of roots) {
    const found = await readArtifactFile(root, relativeFile)
    if (found) return found
  }
  return null
}

async function readArtifactFile(root: string, relativeFile: string): Promise<TaskArtifact | 'too-large' | null> {
  const absolute = join(/*turbopackIgnore: true*/ root, ...relativeFile.split('/'))
  if (!containsPath(root, absolute)) return null
  const parts = relativeFile.split('/')
  let current = root
  let stats
  try {
    if ((await lstat(/*turbopackIgnore: true*/ current)).isSymbolicLink()) return null
    for (const [index, part] of parts.entries()) {
      // The folder is outside this project. The ignore keeps the build from tracing every file in it.
      current = join(/*turbopackIgnore: true*/ current, part)
      stats = await lstat(/*turbopackIgnore: true*/ current)
      if (stats.isSymbolicLink()) return null
      const last = index === parts.length - 1
      if (last ? !stats.isFile() : !stats.isDirectory()) return null
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!stats) return null
  if (stats.size > MAX_ARTIFACT_BYTES) return 'too-large'
  const name = parts[parts.length - 1]
  const contentType = IMAGE_TYPE[extensionOf(name)] ?? 'application/octet-stream'
  return {
    bytes: await readFile(/*turbopackIgnore: true*/ absolute),
    contentType,
    inline: contentType.startsWith('image/'),
    name,
  }
}
