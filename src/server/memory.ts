import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { dataFolder } from './config'
import { getProject, listProjects } from './projects'

// Memory is plain files that agents and the user both read and write.
//
//   <data>/memory/<id>.md                         a global core fact (one per file)
//   <data>/memory/MEMORY.md                       index of the global facts, rewritten on every change
//   <data>/memory/log/YYYY-MM-DD.md               the global work log, one line per entry
//   <data>/memory/projects/<name>/...             the same three for one project
//
// Core facts are injected into every agent's prompt; the work log is only
// searched. Scratch notes stay in the provider session and are never saved here.
//
// Project memory lives under `memory/projects/` rather than `<data>/projects/`
// because the legacy app keeps the user's own repositories in `<data>/projects/`,
// and busyboy never writes into folders it did not create.

export const MEMORY_FOLDER = 'memory'
const PROJECTS_FOLDER = 'projects'
const LOG_FOLDER = 'log'
const INDEX_FILE = 'MEMORY.md'

/**
 * Most characters the memory section may add to a prompt, everything counted:
 * intro, headings, facts in full, facts listed by title, and the Director's
 * project lines. What does not fit is left to memory_search.
 */
const PROMPT_BUDGET = 12_000
/** Kept back for each "N more" line, so those lines always fit too. */
const MORE_LINE_RESERVE = 80

export type MemoryFact = {
  id: string
  /** null for a global fact. */
  project: string | null
  title: string
  text: string
  updatedAt: string
}

export type MemoryScope = { project: string | null; facts: MemoryFact[] }

export type MemorySearchHit = { project: string | null; source: string; text: string }

export class MemoryError extends Error {}

// ---- Folders and validation ------------------------------------------------------

function scopeFolder(folder: string, project: string | null) {
  return project === null ? join(folder, MEMORY_FOLDER) : join(folder, MEMORY_FOLDER, PROJECTS_FOLDER, project)
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/

/** `memory.md` would be the index file on a case-insensitive disk (macOS). */
const RESERVED_ID = INDEX_FILE.slice(0, -3).toLowerCase()

function isFactId(id: string) {
  return ID_PATTERN.test(id) && id !== RESERVED_ID
}

function checkId(id: string) {
  if (!isFactId(id)) throw new MemoryError(`"${id}" is not a memory id. Ids are lowercase letters, digits, and dashes.`)
  return id
}

/**
 * A new fact's id from its title. Titles that are not plain ASCII (Korean,
 * for one) keep only part of their text in the slug, so a short hash of the
 * whole title keeps two such facts from sharing an id.
 */
function idFromTitle(title: string) {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  const ascii = /^[\x20-\x7e]*$/.test(title)
  if (slug && ascii && slug !== RESERVED_ID) return slug
  const hash = createHash('sha256').update(title).digest('hex').slice(0, 8)
  return slug ? `${slug}-${hash}` : `fact-${hash}`
}

/** A project folder name busyboy could have created (never a path). */
function isProjectFolderName(name: string) {
  return Boolean(name) && !/[/\\]/.test(name) && name !== '.' && name !== '..'
}

/**
 * The project's stored name, or null for global memory. A project that was
 * renamed or removed keeps its memory folder; that folder can still be
 * edited, deleted from, and searched.
 *
 * Known limitation: memory is keyed by the project's name, not a stable id,
 * so after a rename the project's agents start from an empty memory folder
 * and the old facts sit under the old name until the user moves them.
 */
async function resolveProject(folder: string, project: string | null | undefined) {
  const name = project?.trim().replace(/^@/, '')
  if (!name) return null
  const found = await getProject(name)
  if (found) return found.name
  if (isProjectFolderName(name) && (await stat(scopeFolder(folder, name)).catch(() => null))?.isDirectory()) return name
  throw new MemoryError(`There is no project named "${name}".`)
}

/** Project names that have a memory folder, sorted. */
async function projectsWithMemory(folder: string) {
  return (await readdir(join(folder, MEMORY_FOLDER, PROJECTS_FOLDER), { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && isProjectFolderName(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
}

// ---- Change listeners and write queue ----------------------------------------------

const LISTENERS_KEY = Symbol.for('busyboy.memory-listeners')
const QUEUE_KEY = Symbol.for('busyboy.memory-writes')
const globalStore = globalThis as typeof globalThis & {
  [LISTENERS_KEY]?: Map<string, Set<() => void>>
  [QUEUE_KEY]?: Map<string, Promise<unknown>>
}
const listeners = (globalStore[LISTENERS_KEY] ??= new Map())
const writeQueues = (globalStore[QUEUE_KEY] ??= new Map())

/** Calls `listener` after any memory in `folder` changes. */
export function subscribeToMemory(folder: string, listener: () => void) {
  let set = listeners.get(folder)
  if (!set) listeners.set(folder, (set = new Set()))
  set.add(listener)
  return () => set.delete(listener)
}

/** Runs memory writes for one data folder one at a time, then tells listeners when facts changed. */
function queueWrite<T>(folder: string, write: () => Promise<T>, factsChanged = true): Promise<T> {
  const next = (writeQueues.get(folder) ?? Promise.resolve()).catch(() => {}).then(write)
  writeQueues.set(folder, next)
  return next.then((result: T) => {
    if (factsChanged) for (const listener of listeners.get(folder) ?? []) listener()
    return result
  })
}

async function writeAtomically(file: string, content: string) {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, content)
  await rename(temporary, file)
}

// ---- Facts -------------------------------------------------------------------------

function factFile(fact: Pick<MemoryFact, 'title' | 'text'>) {
  return `# ${fact.title}\n\n${fact.text}\n`
}

function parseFact(id: string, project: string | null, content: string, updatedAt: string): MemoryFact {
  const heading = /^#\s+(.+)\n?/.exec(content)
  const title = heading ? heading[1].trim() : id
  const text = (heading ? content.slice(heading[0].length) : content).trim()
  return { id, project, title, text, updatedAt }
}

async function readFacts(folder: string, project: string | null): Promise<MemoryFact[]> {
  const dir = scopeFolder(folder, project)
  const names = await readdir(dir).catch(() => [] as string[])
  const facts = await Promise.all(
    names
      .filter((name) => name.endsWith('.md') && isFactId(name.slice(0, -3)))
      .sort()
      .map(async (name) => {
        const file = join(dir, name)
        const [content, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]).catch(() => [null, null] as const)
        return content === null ? null : parseFact(name.slice(0, -3), project, content, info.mtime.toISOString())
      }),
  )
  return facts.filter((fact) => fact !== null)
}

/** Rewrites the scope's index from its facts. Agents read it to see what exists without opening every file. */
async function writeIndex(folder: string, project: string | null) {
  const facts = await readFacts(folder, project)
  const dir = scopeFolder(folder, project)
  const lines = facts.map((fact) => `- [${fact.title}](${fact.id}.md) — ${oneLine(fact.text, 100)}`)
  const heading = project === null ? '# Global memory' : `# Memory for ${project}`
  await writeAtomically(
    join(dir, INDEX_FILE),
    `${heading}\n\nWritten by busyboy. Edit the fact files, not this index.\n\n${lines.join('\n')}\n`,
  )
}

function oneLine(text: string, max: number) {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Every scope with its facts: global first, then each project that has any. */
export async function listMemoryAt(folder: string): Promise<MemoryScope[]> {
  const scopes: MemoryScope[] = [{ project: null, facts: await readFacts(folder, null) }]
  for (const project of await projectsWithMemory(folder)) {
    const facts = await readFacts(folder, project)
    if (facts.length) scopes.push({ project, facts })
  }
  return scopes
}

export async function listMemory() {
  return listMemoryAt(await dataFolder())
}

export type WriteFactInput = { title: string; text: string; project?: string | null; id?: string }

/**
 * Saves a fact. With `id`, that fact is replaced. Without it, a fact with the
 * same title (ignoring case) is replaced, so an agent correcting a fact does
 * not add a twin; otherwise a new id is made from the title, never one in use.
 */
export async function writeFact(input: WriteFactInput): Promise<MemoryFact> {
  const folder = await dataFolder()
  const title = oneLine(input.title, 120)
  const text = input.text.trim()
  if (!title) throw new MemoryError('Give the memory a short title.')
  if (!text) throw new MemoryError('Give the memory some text.')
  const project = await resolveProject(folder, input.project)
  const givenId = input.id?.trim() ? checkId(input.id.trim()) : undefined
  const dir = scopeFolder(folder, project)
  return queueWrite(folder, async () => {
    const id = givenId ?? (await newOrMatchingId(folder, project, title))
    await mkdir(dir, { recursive: true })
    await writeAtomically(join(dir, `${id}.md`), factFile({ title, text }))
    await writeIndex(folder, project)
    return { id, project, title, text, updatedAt: new Date().toISOString() }
  })
}

/** Inside the write queue, so two new facts never take the same id. */
async function newOrMatchingId(folder: string, project: string | null, title: string) {
  const facts = await readFacts(folder, project)
  const same = facts.find((fact) => fact.title.toLowerCase() === title.toLowerCase())
  if (same) return same.id
  // Every file name counts, ignoring case: macOS disks match `Foo.md` to `foo.md`,
  // and a file readFacts skipped must not be overwritten either.
  const names = await readdir(scopeFolder(folder, project)).catch(() => [] as string[])
  const taken = new Set(names.map((name) => name.toLowerCase().replace(/\.md$/, '')))
  const base = idFromTitle(title)
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

/** Deletes a fact. Returns false when there was no such fact. */
export async function forgetFact(input: { id: string; project?: string | null }): Promise<boolean> {
  const folder = await dataFolder()
  const project = await resolveProject(folder, input.project)
  const id = checkId(input.id.trim())
  const dir = scopeFolder(folder, project)
  return queueWrite(folder, async () => {
    const file = join(dir, `${id}.md`)
    const existed = await stat(file).then(
      () => true,
      () => false,
    )
    if (!existed) return false
    await rm(file)
    await writeIndex(folder, project)
    return true
  })
}

// ---- Work log ------------------------------------------------------------------------

/** Local date and time, since the user reads the log by their own calendar. */
function localStamp(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  }
}

/** Adds one line to today's work log. */
export async function appendLog(input: { text: string; project?: string | null }) {
  const folder = await dataFolder()
  const text = oneLine(input.text, 2000)
  if (!text) throw new MemoryError('Give the log entry some text.')
  const project = await resolveProject(folder, input.project)
  const dir = join(scopeFolder(folder, project), LOG_FOLDER)
  const { day, time } = localStamp(new Date())
  await queueWrite(folder, async () => {
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, `${day}.md`), `- ${time} ${text}\n`)
  }, false)
  return `${day}.md`
}

// ---- Search --------------------------------------------------------------------------

/**
 * Finds facts and log lines that contain every word of the query, ignoring case.
 * Newest log days come first.
 */
export async function searchMemory(input: { query: string; project?: string | null; limit?: number }) {
  const folder = await dataFolder()
  const words = input.query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) throw new MemoryError('Give a search query.')
  const matches = (text: string) => {
    const lower = text.toLowerCase()
    return words.every((word) => lower.includes(word))
  }
  const limit = input.limit ?? 20
  const only = input.project ? await resolveProject(folder, input.project) : undefined
  const everyProject = async () => {
    const names = new Set([...(await listProjects()).map(({ name }) => name), ...(await projectsWithMemory(folder))])
    return [...names]
  }
  const scopes = only !== undefined ? [null, only] : [null, ...(await everyProject())]
  const hits: MemorySearchHit[] = []
  for (const project of scopes) {
    for (const fact of await readFacts(folder, project)) {
      if (matches(`${fact.title}\n${fact.text}`)) hits.push({ project, source: `${fact.id}.md`, text: `${fact.title}: ${fact.text}` })
    }
    const logDir = join(scopeFolder(folder, project), LOG_FOLDER)
    const days = (await readdir(logDir).catch(() => [] as string[])).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    for (const day of days.sort().reverse()) {
      const lines = (await readFile(join(logDir, day), 'utf8').catch(() => '')).split('\n')
      for (const line of lines) {
        if (line.trim() && matches(line)) hits.push({ project, source: `${LOG_FOLDER}/${day}`, text: line.replace(/^-\s*/, '') })
      }
    }
  }
  return hits.slice(0, limit)
}

// ---- Prompt --------------------------------------------------------------------------

/**
 * The memory section of an agent's prompt. It goes right after the agent's
 * instructions and before the conversation, and it only changes when a fact
 * changes, so the provider's prompt cache holds between turns.
 *
 * - `project`: a task agent's project; its facts follow the global ones.
 * - `projectIndexes`: the Director spans projects, so it gets each project's
 *   fact count. Not the titles: task agents write project facts
 *   after reading untrusted repository content, and the Director can create tasks.
 */
export async function memoryPrompt(folder: string, options: { project?: string; projectIndexes?: boolean } = {}) {
  const sections: { heading: string; facts: MemoryFact[] }[] = [
    { heading: 'Global', facts: await readFacts(folder, null) },
  ]
  if (options.project) {
    sections.push({
      heading: `Project ${options.project}`,
      facts: await readFacts(folder, options.project),
    })
  }
  const projects = options.projectIndexes ? (await listMemoryAt(folder)).slice(1) : []
  // Task agents stay in their worktree and the Director never reads files, so
  // a fact that does not fit in full is looked up with memory_search, not read.
  const intro = [
    '# Memory',
    '',
    'What busyboy remembers about the user and their work, kept as files you change with the busyboy memory tools. Follow it. When a fact is listed only by title, look it up with memory_search when it matters.',
  ].join('\n')
  if (sections.every(({ facts }) => facts.length === 0) && projects.length === 0) return `${intro}\n\nNothing is saved yet.`

  // Every line counts against the budget, plus its newline.
  const groups = sections.length + (projects.length ? 1 : 0)
  let budget = PROMPT_BUDGET - intro.length - 1 - groups * MORE_LINE_RESERVE
  const body: string[] = []
  const add = (line: string) => {
    if (line.length + 1 > budget) return false
    body.push(line)
    budget -= line.length + 1
    return true
  }
  const more = (count: number, what: string) => {
    if (count > 0) body.push(`- ${count} more ${what} not shown; use memory_search to find them.`)
  }
  for (const section of sections) {
    if (section.facts.length === 0) continue
    let hidden = 0
    if (add(`## ${section.heading}`)) {
      for (const fact of section.facts) {
        if (!add(`### ${fact.title}\n${fact.text}`) && !add(`- ${fact.title} (id ${fact.id})`)) hidden++
      }
    } else hidden = section.facts.length
    more(hidden, 'facts')
  }
  if (projects.length) {
    let hidden = 0
    if (add('## Projects')) {
      for (const { project, facts } of projects) {
        const count = facts.length === 1 ? '1 fact' : `${facts.length} facts`
        if (!add(`- ${project}: ${count}. Its task agents see them; use memory_search to look one up.`)) hidden++
      }
    } else hidden = projects.length
    more(hidden, 'projects with memory')
  }
  return [intro, '', ...body].join('\n')
}
