import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readSettingsAt } from '../config'
import { pathKey } from '../paths'

// End state achievement: the share of agreed end-state items that were met.
// Agreed items are the numbered `## n ·` lines under `# End state` in an
// approved ALIGN.md. Whether each one was met is read from REMEMBER.md and
// STATUS.md. All three are taken from the project's `main` branch, not from a
// task worktree, so the number is what landed, not what a branch still says.

const run = promisify(execFile)

const RECORD = /^\.jwn\/([^/]+)\/(ALIGN\.md|STATUS\.md|REMEMBER\.md)$/
const APPROVED = /^(?:\W*Version:[^·\n]*·)?\W*Status:\s*approved\b/im
const FENCE = /^\s*(```|~~~)/
const NUMBERED = /^(\d+[a-z]?)\s*·\s*(.+)$/i
const MET = /^(met|pass(?:ed)?|ok|proven|yes|done)\b/i
const UNMET = /^(not met|unmet|fail(?:ed)?|no|missing)\b/i

type Line = { text: string; inFence: boolean }

export type TaskAchievement = {
  project: string
  taskId: string
  title: string
  met: number
  agreed: number
  /** When the task's records last changed on main, ISO 8601. */
  at: string
  /** STATUS.md on main says the task is done. */
  done: boolean
}

export type WeekAchievement = {
  /** Monday of the week, UTC, YYYY-MM-DD. */
  start: string
  label: string
  met: number
  agreed: number
  tasks: { project: string; taskId: string; title: string; met: number; agreed: number }[]
}

export type AchievementResult =
  | { ok: true; tasks: TaskAchievement[]; weeks: WeekAchievement[] }
  | { ok: false; error: string }

type Cache = Map<string, { key: string; result: AchievementResult }>
const CACHE_KEY = Symbol.for('busyboy.end-state')
const globalStore = globalThis as typeof globalThis & { [CACHE_KEY]?: Cache }
const cache: Cache = (globalStore[CACHE_KEY] ??= new Map())

/** Monday (UTC) of the week containing `iso`, as YYYY-MM-DD. */
export function weekStart(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = utc.getUTCDay()
  utc.setUTCDate(utc.getUTCDate() - (day === 0 ? 6 : day - 1))
  return utc.toISOString().slice(0, 10)
}

const weekFormat = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** "Nov 9 – Nov 15" for a Monday from `weekStart`. */
export function weekLabel(start: string) {
  const [year, month, day] = start.split('-').map(Number)
  const monday = new Date(Date.UTC(year, month - 1, day))
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)
  return `${weekFormat.format(monday)} – ${weekFormat.format(sunday)}`
}

function toLines(text: string): Line[] {
  let inFence = false
  return text.split(/\r?\n/).map((text) => {
    const isFence = FENCE.test(text)
    const line = { text, inFence: inFence || isFence }
    if (isFence) inFence = !inFence
    return line
  })
}

function headingOf(line: Line) {
  if (line.inFence) return null
  const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line.text)
  return match ? { level: match[1].length, title: match[2].trim() } : null
}

const sectionName = (title: string) => title.replace(/^\d+[a-z]?\s*·\s*/i, '').trim().toLowerCase()

function section(lines: Line[], name: string) {
  const start = lines.findIndex((line) => {
    const heading = headingOf(line)
    return heading?.level === 1 && sectionName(heading.title) === name
  })
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => headingOf(line)?.level === 1)
  return end === -1 ? rest : rest.slice(0, end)
}

function tableCells(text: string) {
  const trimmed = text.trim()
  if (!trimmed.startsWith('|')) return null
  return trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

const isSeparator = (cells: string[]) => cells.every((cell) => /^:?-{3,}:?$/.test(cell))

function tableRows(lines: Line[]) {
  const rows: { header: string[]; cells: string[] }[] = []
  let header: string[] | null = null
  lines.forEach((line, index) => {
    const cells = line.inFence ? null : tableCells(line.text)
    if (!cells || isSeparator(cells)) return
    const next = lines[index + 1]
    const nextCells = next && !next.inFence ? tableCells(next.text) : null
    if (nextCells && isSeparator(nextCells)) header = cells
    else if (header) rows.push({ header, cells })
  })
  return rows
}

type Item = { id: string; title: string }

/** Numbered end-state items. Bullets count only when the section has no numbered headings. */
function endStateItems(text: string): Item[] {
  const lines = section(toLines(text), 'end state')
  if (!lines) return []
  const numbered: Item[] = []
  for (const line of lines) {
    const heading = headingOf(line)
    if (heading?.level !== 2) continue
    const match = NUMBERED.exec(heading.title)
    if (match) numbered.push({ id: match[1].toLowerCase(), title: match[2].trim() })
  }
  if (numbered.length > 0) return numbered
  const bullets: Item[] = []
  for (const line of lines) {
    if (line.inFence) continue
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line.text)
    if (!bullet || /^[^:]{0,40}:\s/.test(bullet[1])) continue
    bullets.push({ id: String(bullets.length + 1), title: bullet[1].trim() })
  }
  return bullets
}

function itemId(text: string) {
  const match = /^\s*(?:end state\s+)?(\d+[a-z]?)\b/i.exec(text.replace(/[*`]/g, ''))
  return match ? match[1].toLowerCase() : null
}

function verdictOf(text: string): 'met' | 'unmet' | null {
  const value = text.trim()
  if (UNMET.test(value)) return 'unmet'
  if (MET.test(value)) return 'met'
  return null
}

/**
 * Results for end-state items. REMEMBER.md counts item tables and `End state n:`
 * bullets. STATUS.md counts those bullets too, and a table whose first column
 * is the end state — not the todo table, whose ids would collide.
 */
function readVerdicts(remember: string | null, status: string | null) {
  const verdicts = new Map<string, 'met' | 'unmet'>()
  const set = (id: string | null, verdict: 'met' | 'unmet' | null) => {
    if (!id || !verdict) return
    if (verdicts.get(id) === 'unmet') return
    verdicts.set(id, verdict)
  }
  const linesOf = (text: string | null) => (text === null ? [] : toLines(text))
  for (const line of [...linesOf(remember), ...linesOf(status)]) {
    if (line.inFence) continue
    const bullet = /^\s*-\s+(.+?):\s*(.+)$/.exec(line.text)
    if (!bullet || !/end state|^\d/i.test(bullet[1])) continue
    set(itemId(bullet[1]), verdictOf(bullet[2]))
  }
  const tables = (text: string | null, endStateOnly: boolean) => {
    for (const { header, cells } of tableRows(linesOf(text))) {
      const item = header.findIndex((cell) => (endStateOnly ? /^end state$/i : /^(item|end state|criterion|id)$/i).test(cell))
      const result = header.findIndex((cell) => /^(result|status|met)$/i.test(cell))
      if (item === -1 || result === -1) continue
      set(itemId(cells[item] ?? ''), verdictOf(cells[result] ?? ''))
    }
  }
  tables(remember, false)
  tables(status, true)
  return verdicts
}

function stateText(status: string | null) {
  if (status === null) return null
  const states = [
    ...new Set(
      toLines(status).flatMap((line) => {
        if (line.inFence) return []
        const match = /^\s*(?:-\s*)?State:\s*(.+?)\s*$/i.exec(line.text)
        return match ? [match[1]] : []
      }),
    ),
  ]
  return states.length === 1 ? states[0] : null
}

const isDoneState = (text: string | null) => text !== null && /^(done|complete|completed|finished|merged|shipped)\b/i.test(text)

function achievementOf({
  project,
  taskId,
  align,
  remember,
  status,
  at,
}: {
  project: string
  taskId: string
  align: string
  remember: string | null
  status: string | null
  at: string
}): TaskAchievement | null {
  if (!APPROVED.test(align)) return null
  const items = endStateItems(align)
  if (items.length === 0 || !weekStart(at)) return null
  const verdicts = readVerdicts(remember, status)
  const title = /^#\s+ALIGN:\s*(.+?)\s*$/m.exec(align)?.[1] ?? taskId
  let met = 0
  for (const item of items) {
    if (verdicts.get(item.id) === 'met') met += 1
  }
  return { project, taskId, title, met, agreed: items.length, at, done: isDoneState(stateText(status)) }
}

function weeksOf(tasks: TaskAchievement[]): WeekAchievement[] {
  const weeks = new Map<string, WeekAchievement>()
  for (const task of tasks) {
    const start = weekStart(task.at)
    if (!start) continue
    let week = weeks.get(start)
    if (!week) {
      week = { start, label: weekLabel(start), met: 0, agreed: 0, tasks: [] }
      weeks.set(start, week)
    }
    week.met += task.met
    week.agreed += task.agreed
    week.tasks.push({ project: task.project, taskId: task.taskId, title: task.title, met: task.met, agreed: task.agreed })
  }
  for (const week of weeks.values()) week.tasks.sort((a, b) => a.title.localeCompare(b.title) || a.taskId.localeCompare(b.taskId))
  return [...weeks.values()].sort((a, b) => (a.start < b.start ? 1 : -1))
}

type GitError = NodeJS.ErrnoException & { stderr?: string }

function git(repo: string, args: string[]) {
  return run('git', ['-C', repo, '-c', 'core.quotepath=false', ...args], {
    encoding: 'buffer',
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  })
}

/** One `cat-file --batch` for every record, in the order asked. Null when main has no such file. */
function catFiles(repo: string, specs: string[]): Promise<(string | null)[]> {
  if (specs.length === 0) return Promise.resolve([])
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repo, '-c', 'core.quotepath=false', 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const chunks: Buffer[] = []
    let stderr = ''
    const timer = setTimeout(() => child.kill(), 15_000)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(stderr.trim() || `git cat-file exited ${code}`))
        return
      }
      try {
        resolve(parseBatch(Buffer.concat(chunks), specs.length))
      } catch (error) {
        reject(error)
      }
    })
    child.stdin.end(specs.map((spec) => `${spec}\n`).join(''))
  })
}

function parseBatch(buffer: Buffer, count: number) {
  const results: (string | null)[] = []
  let offset = 0
  while (results.length < count) {
    const end = buffer.indexOf(0x0a, offset)
    if (end === -1) break
    const header = buffer.toString('utf8', offset, end)
    offset = end + 1
    if (header.endsWith(' missing')) {
      results.push(null)
      continue
    }
    const size = Number(header.split(' ').at(-1))
    if (!Number.isInteger(size) || size < 0) throw new Error(`git cat-file returned "${header}".`)
    results.push(buffer.subarray(offset, offset + size).toString('utf8'))
    offset += size
    if (buffer[offset] === 0x0a) offset += 1
  }
  if (results.length !== count) throw new Error('git cat-file returned fewer objects than asked.')
  return results
}

/** Latest commit time on main for each `.jwn/<task>/`, from a newest-first log. */
function datesByTask(log: string) {
  const dates = new Map<string, string>()
  let date: string | null = null
  for (const line of log.split(/\r?\n/)) {
    if (!line) continue
    if (/^\d{4}-\d{2}-\d{2}T/.test(line)) {
      date = line.trim()
      continue
    }
    const id = /^\.jwn\/([^/]+)\//.exec(line)?.[1]
    if (date && id && !dates.has(id)) dates.set(id, date)
  }
  return dates
}

async function projectTasks(project: string, repo: string): Promise<TaskAchievement[]> {
  let listed: string
  let log: string
  try {
    const [tree, history] = await Promise.all([
      git(repo, ['ls-tree', '-r', '--name-only', 'main', '--', '.jwn']),
      git(repo, ['log', '--format=%cI', '--name-only', 'main', '--', '.jwn']),
    ])
    listed = tree.stdout.toString('utf8')
    log = history.stdout.toString('utf8')
  } catch (error) {
    if ((error as GitError).code === 'ENOENT') throw error
    return []
  }
  const files = new Map<string, { align?: string; remember?: string; status?: string }>()
  const specs: string[] = []
  for (const line of listed.split(/\r?\n/)) {
    const match = RECORD.exec(line)
    if (!match) continue
    const kind = match[2] === 'ALIGN.md' ? 'align' : match[2] === 'REMEMBER.md' ? 'remember' : 'status'
    const entry = files.get(match[1]) ?? {}
    entry[kind] = `main:${line}`
    files.set(match[1], entry)
    specs.push(`main:${line}`)
  }
  if (specs.length === 0) return []
  const bodies = await catFiles(repo, specs)
  const bySpec = new Map(specs.map((spec, index) => [spec, bodies[index]]))
  const dates = datesByTask(log)
  const tasks: TaskAchievement[] = []
  for (const [taskId, paths] of files) {
    const align = paths.align ? bySpec.get(paths.align) : null
    if (!align) continue
    const at = dates.get(taskId)
    if (!at) continue
    const task = achievementOf({
      project,
      taskId,
      align,
      remember: paths.remember ? (bySpec.get(paths.remember) ?? null) : null,
      status: paths.status ? (bySpec.get(paths.status) ?? null) : null,
      at,
    })
    if (task) tasks.push(task)
  }
  return tasks
}

async function mainSha(repo: string) {
  try {
    const { stdout } = await git(repo, ['rev-parse', '--verify', '--quiet', 'main'])
    const sha = stdout.toString('utf8').trim()
    return sha || null
  } catch (error) {
    if ((error as GitError).code === 'ENOENT') throw error
    return null
  }
}

/** End state achievement for every project, from the records committed on `main`. */
export async function readEndStateAchievement(folder: string): Promise<AchievementResult> {
  let projects: { name: string; path: string }[]
  try {
    const settings = await readSettingsAt(folder)
    projects = settings.projects.flatMap((project) => (typeof project?.name === 'string' && typeof project.path === 'string' ? [{ name: project.name, path: project.path }] : []))
  } catch (error) {
    return { ok: false, error: `Settings could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
  let shas: (string | null)[]
  try {
    shas = await Promise.all(projects.map((project) => mainSha(project.path)))
  } catch (error) {
    return { ok: false, error: 'git was not found, so end state achievement could not be read.' }
  }
  const key = projects.map((project, index) => `${pathKey(project.path)}@${shas[index] ?? ''}`).join('\n')
  const cached = cache.get(pathKey(folder))
  if (cached?.key === key) return cached.result
  try {
    const tasks = (await Promise.all(projects.map((project, index) => (shas[index] ? projectTasks(project.name, project.path) : Promise.resolve([]))))).flat()
    tasks.sort((a, b) => a.project.localeCompare(b.project) || a.taskId.localeCompare(b.taskId))
    const result: AchievementResult = { ok: true, tasks, weeks: weeksOf(tasks) }
    cache.set(pathKey(folder), { key, result })
    return result
  } catch (error) {
    if ((error as GitError).code === 'ENOENT') return { ok: false, error: 'git was not found, so end state achievement could not be read.' }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
