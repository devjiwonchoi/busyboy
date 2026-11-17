import { execFile } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { getAgent, subscribeToAgent } from '../runner/agent-runner'
import { findExecutable } from '../runner/find-executable'
import { readEndStateAchievement } from '../records/end-state'
import { parseRecords, type RecordTexts, type TodoResult } from '../records/parse-records'
import { CardError, openCards, presentCard, settleCard } from '../task-cards'
import type { ProgressStep, ProgressStepState, PullRequestCheck, PullRequestRow, TaskCard } from './model'

// Progress, done, and pull-request cards. Question, approval, and plan cards are
// opened by trackTaskCards. These three come from the task's records: STATUS.md
// says how far the todos got and, once pull requests exist, lists them. Nothing
// here merges a pull request; mergePullRequests runs only when the user clicks.

const run = promisify(execFile)

type WorkTask = {
  id: string
  project: string
  title: string
  agentId: string
  worktree: string
  chat?: string | null
  kind?: 'subagent'
}

const progressId = (taskId: string) => `progress:${taskId}`
const doneId = (taskId: string) => `done:${taskId}`
const prId = (taskId: string) => `pr:${taskId}`

/** Follows one task agent and keeps its progress, done, and pull-request cards in step with its records. */
export function trackWorkCards({ folder, task }: { folder: string; task: WorkTask }) {
  if (task.kind === 'subagent') return
  // A newer turn, or a stop, invalidates a sync that is still reading the records.
  let epoch = 0
  subscribeToAgent(task.agentId, 0, ({ event }) => {
    if (event.type === 'stopped') {
      epoch += 1
      for (const id of [progressId(task.id), doneId(task.id), prId(task.id)]) settleIfOpen(folder, id, 'Stopped')
      return
    }
    if (event.type !== 'turn-done' || event.more) return
    const ticket = ++epoch
    void syncWorkCards(folder, task, () => ticket === epoch).catch((error: unknown) =>
      console.error(`busyboy: could not update the cards of ${task.id}`, error),
    )
  })
}

function settleIfOpen(folder: string, cardId: string, outcome: string) {
  if (!openCards(folder).some((card) => card.id === cardId)) return
  settleCard({ folder, cardId, outcome })
}

async function syncWorkCards(folder: string, task: WorkTask, fresh: () => boolean) {
  const read = await readWorkRecords(task)
  if (!fresh() || getAgent(task.agentId)?.status === 'stopped' || !read) return
  const now = new Date().toISOString()
  const steps = stepsFrom(read.records.todos)
  const finished = read.records.state === 'done'
  const working = !finished && steps.some((step) => step.state === 'done' || step.state === 'running')

  if (working) {
    show(folder, task, { ...source(task, progressId(task.id), now), kind: 'progress', title: task.title, steps })
  } else if (!finished) {
    settleIfOpen(folder, progressId(task.id), 'Closed')
  }
  if (!fresh()) return

  if (finished) {
    // Replace the progress card in place. Settling it would also write a second closed card.
    const progress = openCards(folder).find((card) => card.id === progressId(task.id))
    const report = await readEndStateAchievement(folder).catch(() => null)
    if (!fresh()) return
    const found = report?.ok ? report.tasks.find((item) => item.project === task.project && item.taskId === task.id && item.agreed > 0) : undefined
    show(folder, task, {
      ...source(task, progress?.id ?? doneId(task.id), progress?.openedAt ?? now),
      kind: 'done',
      title: task.title,
      // The share of agreed end-state items met on main. Null keeps the line as check, name, and Done.
      achievement: found ? { met: found.met, agreed: found.agreed } : null,
    })
  } else {
    settleIfOpen(folder, doneId(task.id), 'Reopened')
    const progress = openCards(folder).find((card) => card.id === progressId(task.id))
    if (progress?.kind === 'done') settleIfOpen(folder, progress.id, 'Reopened')
  }

  if (read.pulls.length > 0) {
    show(folder, task, {
      ...source(task, prId(task.id), now),
      kind: 'pr',
      title: `Stacked PRs (${read.pulls.length})`,
      note: 'Approved to merge. This does not deploy.',
      pulls: read.pulls,
    })
  } else {
    settleIfOpen(folder, prId(task.id), 'Closed')
  }
}

function source(task: WorkTask, id: string, openedAt: string) {
  return {
    id,
    taskId: task.id,
    chat: task.chat ?? null,
    project: task.project,
    taskTitle: task.title,
    openedAt,
  }
}

/** Replacing a card keeps its `openedAt`, so an update does not jump it in the timeline. */
function show(folder: string, task: WorkTask, card: TaskCard) {
  const current = openCards(folder).find((item) => item.id === card.id)
  const next: TaskCard = current ? { ...card, openedAt: current.openedAt } : card
  if (current && JSON.stringify(current) === JSON.stringify(next)) return
  presentCard({ folder, card: next, agentId: task.agentId })
}

function stepState(result: TodoResult): ProgressStepState {
  if (result === 'done') return 'done'
  if (result === 'running' || result === 'needs-you') return 'running'
  return 'pending'
}

/**
 * Todo results become the progress card's steps. When work has started and no
 * todo is marked running, the first one still waiting is the running step.
 */
function stepsFrom(todos: { id: string; title: string; result: TodoResult }[]): ProgressStep[] {
  const steps: ProgressStep[] = todos.map((todo) => ({ id: todo.id, label: todo.title, state: stepState(todo.result) }))
  if (steps.some((step) => step.state === 'running') || steps.every((step) => step.state === 'done')) return steps
  const next = steps.find((step) => step.state === 'pending')
  if (next && steps.some((step) => step.state === 'done')) next.state = 'running'
  return steps
}

async function readWorkRecords(task: Pick<WorkTask, 'id' | 'worktree'>) {
  const { recordFolderOf } = await import('../records/project-graph')
  const located = await recordFolderOf(task)
  if (!located || !('folder' in located)) return null
  const texts: RecordTexts = {}
  let status = ''
  for (const file of ['ALIGN.md', 'STATUS.md'] as const) {
    // The record folder is the task's worktree, outside this project. The ignore keeps the build from tracing every file.
    const path = join(/*turbopackIgnore: true*/ located.folder, file)
    try {
      // A linked record could point anywhere on the machine, same as the project graph.
      if ((await lstat(/*turbopackIgnore: true*/ path)).isSymbolicLink()) continue
      const text = await readFile(/*turbopackIgnore: true*/ path, 'utf8')
      texts[file] = text
      if (file === 'STATUS.md') status = text
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return { records: parseRecords(texts), pulls: parsePullRequests(status) }
}

// ---- Pull requests -----------------------------------------------------------

const CHECK_WORD: [RegExp, PullRequestCheck][] = [
  [/^(pass|passed|passing|ok|success|green)\b/i, 'passing'],
  [/^(fail|failed|failing|error|red)\b/i, 'failing'],
  [/^(pending|running|queued|in progress|yellow)\b/i, 'pending'],
]

function clip(text: string, max: number) {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function tableCells(line: string) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return null
  return trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

const isSeparator = (cells: string[]) => cells.every((cell) => /^:?-{3,}:?$/.test(cell))

/** The lines of a top-level `# <name>` section, skipping fenced code. */
function sectionLines(text: string, name: string) {
  let fenced = false
  const lines: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (!fenced) lines.push(line)
  }
  const start = lines.findIndex((line) => new RegExp(`^#\\s+${name}\\s*$`, 'i').test(line.trim()))
  if (start === -1) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^#\s+\S/.test(line.trim()))
  return end === -1 ? rest : rest.slice(0, end)
}

function column(header: string[], pattern: RegExp) {
  return header.findIndex((cell) => pattern.test(cell))
}

function pullCheck(value: string): PullRequestCheck {
  return CHECK_WORD.find(([pattern]) => pattern.test(value.trim()))?.[1] ?? 'none'
}

function pullNumber(value: string) {
  if (!/^\d+$/.test(value.trim())) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function pullUrl(value: string) {
  const url = value.trim()
  if (!/^https?:\/\//i.test(url) || /\s/.test(url) || url.length > 500) return null
  return url
}

/**
 * The `# Pull requests` table in STATUS.md. Rows stay in the order written,
 * which is stack order: the base of the stack is first and is merged first.
 * A row without a pull number and an http(s) URL is skipped.
 */
export function parsePullRequests(status: string): PullRequestRow[] {
  const lines = sectionLines(status, 'Pull requests')
  let header: string[] | null = null
  const rows: PullRequestRow[] = []
  const seen = new Set<number>()
  for (let index = 0; index < lines.length; index += 1) {
    const cells = tableCells(lines[index])
    if (!cells || isSeparator(cells)) continue
    const next = tableCells(lines[index + 1] ?? '')
    if (next && isSeparator(next)) {
      header = cells
      continue
    }
    if (!header) continue
    const number = pullNumber(cells[column(header, /^(number|#|pr)$/i)] ?? '')
    const url = pullUrl(cells[column(header, /^(url|link)$/i)] ?? '')
    if (number === null || url === null || seen.has(number)) continue
    seen.add(number)
    const title = clip(cells[column(header, /^(title|name)$/i)] ?? '', 120)
    rows.push({
      number,
      title: title || `Pull request #${number}`,
      url,
      check: pullCheck(cells[column(header, /^(check|checks|ci)$/i)] ?? ''),
      review: clip(cells[column(header, /^review$/i)] ?? '', 40),
    })
  }
  return rows
}

/** The task's ALIGN.md, for the done card's View plan link. Null when the task has no plan. */
export async function readTaskPlan({ folder, taskId }: { folder: string; taskId: string }) {
  const { readTasksAt } = await import('../tasks')
  const task = (await readTasksAt(folder)).find((item) => item.id === taskId)
  if (!task) throw new CardError('The task for this card is gone.')
  const { recordFolderOf } = await import('../records/project-graph')
  const located = await recordFolderOf(task)
  if (!located || !('folder' in located)) return null
  const path = join(/*turbopackIgnore: true*/ located.folder, 'ALIGN.md')
  try {
    if ((await lstat(/*turbopackIgnore: true*/ path)).isSymbolicLink()) return null
    const plan = await readFile(/*turbopackIgnore: true*/ path, 'utf8')
    const title = /^#\s+ALIGN:\s*(.+?)\s*$/m.exec(plan)?.[1] ?? task.title
    return { title, plan }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function githubCli() {
  return process.env.BUSYBOY_GH_PATH || findExecutable('gh')
}

/**
 * Merges the open card's pull requests one at a time, base of the stack first.
 * Called only from the Merge button. Opening the card, or any other sync, does not merge.
 */
export async function mergePullRequests({ folder, cardId }: { folder: string; cardId: string }) {
  const card = openCards(folder).find((item) => item.id === cardId)
  if (!card || card.kind !== 'pr') throw new CardError('Only a pull request card can be merged.')
  if (card.pulls.length === 0) throw new CardError('This card has no pull requests to merge.')
  const gh = githubCli()
  if (!gh) throw new CardError('The GitHub CLI (gh) is not installed, so the pull requests could not be merged.')
  const { readTasksAt } = await import('../tasks')
  const task = (await readTasksAt(folder)).find((item) => item.id === card.taskId)
  if (!task) throw new CardError('The task for this card is gone.')
  // Read again at the click: the card may have closed while the action was queued.
  if (!openCards(folder).some((item) => item.id === cardId && item.kind === 'pr')) {
    throw new CardError('This card was already answered.')
  }
  for (const pull of card.pulls) {
    try {
      // `--merge` picks a merge commit. It is not `--auto`, which would merge later without another click.
      await run(gh, ['pr', 'merge', String(pull.number), '--merge'], { cwd: task.worktree, timeout: 120_000 })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new CardError(`Pull request #${pull.number} could not be merged. ${detail}`)
    }
  }
  settleCard({ folder, cardId, outcome: 'Merged in order' })
}
