import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CardKind } from '../cards/model'
import { SETTINGS_FILE } from '../config'
import { sameEntryName } from '../paths'
import { openCards } from '../task-cards'
import { readTasksAt, taskView, type TaskRecord, type TaskStatus } from '../tasks'
import { parseRecords, RECORD_FILES, type BuildsOn, type ParsedRecords, type RecordError, type RecordTexts } from './parse-records'
import { taskPhase, type TaskPhase } from './task-phase'

// project → task → todo, built from the task list, each task's `.jwn` records,
// and its agent's live status. Plain data, so it can be sent to the window and
// summarized for the Director.

/** amber = needs-you, blue = running, green = done, gray = not-started, red = stopped. */
export type NodeStatus = 'needs-you' | 'running' | 'done' | 'not-started' | 'stopped'

export type GraphTodo = { id: string; title: string; goal: string | null; status: NodeStatus; resultText: string | null }

export type GraphTask = {
  id: string
  project: string
  title: string
  branch: string
  worktree: string
  /** When a record file last changed, or when the task was created if it has none (ISO 8601). */
  updatedAt: string
  status: NodeStatus
  /** The word on the task row and the project pill. */
  phase: TaskPhase
  stage: string | null
  stateText: string | null
  /** Why the task stopped when it could not resume after a restart. */
  note: string | null
  todos: GraphTodo[]
  /** `found` is false when no task in the graph has that name. */
  buildsOn: (BuildsOn & { found: boolean })[]
  checks: ParsedRecords['checks']
  openFindings: number
  /** Non-empty when a record could not be read; the task then shows as an error node. */
  errors: RecordError[]
}

export type GraphProject = { name: string; tasks: GraphTask[] }

/** `error` is set when the task list or settings cannot be read, so the graph would be incomplete. */
export type ProjectGraph = { projects: GraphProject[]; error?: string }

export const RECORDS_FOLDER = '.jwn'

type RecordFolder = { folder: string } | { error: string } | null

/**
 * The task's record folder. Task agents are told to use `.jwn/<task id>/`;
 * when an agent named it differently and there is exactly one folder holding
 * a record file, that one is used. Anything else is an error rather than an
 * empty record, which would look like a task with no progress.
 */
export async function recordFolderOf(task: Pick<TaskRecord, 'id' | 'worktree'>): Promise<RecordFolder> {
  const root = join(task.worktree, RECORDS_FOLDER)
  let names: string[]
  try {
    // A linked `.jwn` could point anywhere on the machine, like a linked record file.
    if ((await lstat(root)).isSymbolicLink()) return { error: `${RECORDS_FOLDER} is a symbolic link.` }
    names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map(({ name }) => name)
  } catch {
    return null
  }
  // The folder may differ in case from the task id on a case-insensitive disk.
  const named = names.find((name) => sameEntryName(name, task.id))
  if (named) return { folder: join(root, named) }
  const withRecords = (
    await Promise.all(
      names.map(async (name) => {
        const files = await readdir(join(root, name)).catch(() => [] as string[])
        return RECORD_FILES.some((file) => files.includes(file)) ? name : null
      }),
    )
  ).filter((name) => name !== null)
  if (withRecords.length === 1) return { folder: join(root, withRecords[0]) }
  if (withRecords.length === 0) return null
  return { error: `There is no ${RECORDS_FOLDER}/${task.id}/ folder, and several others hold records: ${withRecords.join(', ')}.` }
}

async function readRecordTexts(recordFolder: string): Promise<{ texts: RecordTexts; changedAt: number | null }> {
  const texts: RecordTexts = {}
  let changedAt: number | null = null
  await Promise.all(
    RECORD_FILES.map(async (file) => {
      const path = join(recordFolder, file)
      try {
        // Records are the agent's own files in its worktree; a link could point anywhere on the machine.
        const stats = await lstat(path)
        if (stats.isSymbolicLink()) texts[file] = { error: 'it is a symbolic link' }
        else {
          texts[file] = await readFile(path, 'utf8')
          changedAt = Math.max(changedAt ?? 0, stats.mtimeMs)
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') texts[file] = { error: code ?? String(error) }
      }
    }),
  )
  return { texts, changedAt }
}

/**
 * The agent's live state wins while it works or waits on the user, since the
 * record may not be rewritten yet (an answered question, a follow-up after
 * done). Otherwise the record says where the work is, and the agent fills in
 * when there is no record.
 */
function taskStatus(records: ParsedRecords, agent: TaskStatus): NodeStatus {
  if (agent === 'needs-you' || agent === 'running') return agent
  switch (records.state) {
    case 'done':
      return 'done'
    case 'needs-you':
      return 'needs-you'
    case 'stopped':
      return 'stopped'
    case 'running':
      // The turn ended and the record still says the work is running. That is
      // the work continuing between turns, not a request for the user.
      if (agent === 'idle') return 'running'
      break
  }
  // The process is gone (or never came back after a restart), whatever the record last said.
  if (agent === 'stopped') return 'stopped'
  // The agent ended its turn without finishing: it waits for a reply, for example to approve the plan.
  return 'needs-you'
}

/** A task that could not resume has no agent, whatever its records last said. */
const resumeFailed = (task: TaskRecord) => Boolean(task.note) && taskView(task).status === 'stopped'

async function readTask(task: TaskRecord, cards: readonly CardKind[]) {
  const folder = await recordFolderOf(task)
  const read = folder && 'folder' in folder ? await readRecordTexts(folder.folder) : { texts: {}, changedAt: null }
  const records = parseRecords(read.texts)
  if (folder && 'error' in folder) records.errors.push({ file: RECORDS_FOLDER, message: folder.error })
  const view = taskView(task)
  const failed = resumeFailed(task)
  return {
    id: task.id,
    project: task.project,
    title: task.title,
    branch: task.branch,
    worktree: task.worktree,
    updatedAt: read.changedAt === null ? task.createdAt : new Date(read.changedAt).toISOString(),
    status: failed && records.state !== 'done' ? 'stopped' : taskStatus(records, view.status),
    phase: taskPhase({ agent: view.status, records, cards, resumeFailed: failed }),
    note: task.note ?? null,
    stage: records.stage,
    stateText: records.stateText,
    todos: records.todos.map(({ id, title, goal, result, resultText }) => ({ id, title, goal, status: result, resultText })),
    buildsOn: records.buildsOn,
    checks: records.checks,
    openFindings: records.openFindings,
    errors: records.errors,
  }
}

/**
 * The project names in settings. Read directly rather than through
 * `readSettingsAt`, which moves a corrupt file aside: the watcher reads this
 * every second and must never change a file the user may be editing.
 */
async function projectNames(folder: string): Promise<string[]> {
  let text: string
  try {
    text = await readFile(join(folder, SETTINGS_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const projects = (JSON.parse(text) as { projects?: unknown }).projects
  if (!Array.isArray(projects)) return []
  return projects.flatMap((project) => (typeof project?.name === 'string' ? [project.name as string] : []))
}

export async function readProjectGraph(folder: string): Promise<ProjectGraph> {
  let names: string[]
  let tasks: TaskRecord[]
  try {
    ;[names, tasks] = await Promise.all([projectNames(folder), readTasksAt(folder)])
  } catch (error) {
    return { projects: [], error: `The task list or settings could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
  // The task list can be edited by hand. An entry without these fields cannot be placed or read,
  // and reading it would throw on every rescan, so the graph says the list is broken instead.
  if (!tasks.every((task) => typeof task?.id === 'string' && typeof task.project === 'string' && typeof task.worktree === 'string')) {
    return { projects: [], error: 'The task list could not be read: an entry is missing its id, project, or worktree.' }
  }
  const projects = new Map<string, Awaited<ReturnType<typeof readTask>>[]>(names.map((name) => [name, []]))
  const cardsOf = new Map<string, CardKind[]>()
  for (const card of openCards(folder)) {
    const kinds = cardsOf.get(card.taskId)
    if (kinds) kinds.push(card.kind)
    else cardsOf.set(card.taskId, [card.kind])
  }
  // A subagent runs in the project's own checkout and writes no records; any `.jwn` there is the user's.
  // An archived task is out of the way until it is restored.
  const shown = tasks.filter(({ kind, archivedAt }) => kind !== 'subagent' && !archivedAt)
  for (const task of await Promise.all(shown.map((task) => readTask(task, cardsOf.get(task.id) ?? [])))) {
    // A task whose project was removed from settings still shows under its own name.
    let list = projects.get(task.project)
    if (!list) projects.set(task.project, (list = []))
    list.push(task)
  }
  const known = new Set([...projects.values()].flat().map(({ project, id }) => `${project}/${id}`))
  return {
    projects: [...projects].map(([name, list]) => ({
      name,
      tasks: list.map((task) => ({
        ...task,
        buildsOn: task.buildsOn.map((base) => ({ ...base, found: known.has(`${base.project}/${base.task}`) })),
      })),
    })),
  }
}
