// Writes one REMEMBER.md per finished task under the jwn record root, and reads
// those records back by ISO week. The shape comes from the task-recording and
// retro skills: front matter the delegation-rate script accepts, then the
// evidence those counts were taken from.
//
// The Remember file is REMEMBER.md. RETRO.md is the name the script on main
// still scans for; a task that only has the old file is still read.

import { execFile, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { lstat, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { agentEnvironment } from '../runner/find-executable'
import { parseRecords } from './parse-records'

export const TEST_REMEMBER_ROOT = 'jwn-records'
export const REMEMBER_FILE = 'REMEMBER.md'
export const LEGACY_REMEMBER_FILE = 'RETRO.md'
const VERSION_FILE = 'VERSION'
const OBSERVATIONS_FILE = 'remember-observations.json'
const RECORD_VERSION = '1'

const run = promisify(execFile)

export type RememberTask = {
  id: string
  project: string
  worktree: string
  kind?: 'subagent'
}

export type DelegationRecord = {
  path: string
  date: string
  interventionsAfterApproval: number
  endStateItemsTotal: number
  endStateItemsMet: number
  reviewChangeRequests: number
  delegated: boolean
  /** Empty when the task was delegated. Names match the delegation-rate script. */
  reasons: string[]
}

export type WeekDelegation = {
  week: string
  weekStart: string
  weekEnd: string
  records: DelegationRecord[]
  /** Files in the week the delegation-rate script would reject. */
  rejected: { path: string; reason: string }[]
}

type Stored = {
  approvedAt: string | null
  /** User messages, including ones from before approval. The approval message is not one of these. */
  messages: string[]
  interruptions: string[]
  /** Commits created while the agent was in a turn after approval. */
  agentCommits: string[]
  approvedHead: string | null
  /** HEAD when the current post-approval turn started. Null between turns. */
  turnStart: string | null
  /** Local date of the first record, kept when the file is written again. */
  finishedOn: string | null
}

type ObservationFile = { version: 1; tasks: Record<string, Stored> }

type EndStateItem = { label: string; id: string | null }

const STORE_KEY = Symbol.for('busyboy.remember-observations')
const CHAIN_KEY = Symbol.for('busyboy.remember-chains')
const globalStore = globalThis as typeof globalThis & {
  [STORE_KEY]?: Map<string, Map<string, Stored>>
  [CHAIN_KEY]?: Map<string, Promise<void>>
}
const stores = (globalStore[STORE_KEY] ??= new Map())
const chains = (globalStore[CHAIN_KEY] ??= new Map())
const persistChains = new Map<string, Promise<void>>()

/** `YYYY-MM-DD` in the machine's local timezone, which is the user's date for a desktop app. */
export function localIsoDate(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function emptyStored(): Stored {
  return {
    approvedAt: null,
    messages: [],
    interruptions: [],
    agentCommits: [],
    approvedHead: null,
    turnStart: null,
    finishedOn: null,
  }
}

function storeFor(folder: string): Map<string, Stored> {
  let store = stores.get(folder)
  if (store) return store
  store = new Map()
  try {
    const parsed = JSON.parse(readFileSync(join(folder, OBSERVATIONS_FILE), 'utf8')) as ObservationFile
    if (parsed?.version === 1 && parsed.tasks && typeof parsed.tasks === 'object') {
      for (const [id, value] of Object.entries(parsed.tasks)) {
        if (value && typeof value === 'object') store.set(id, { ...emptyStored(), ...value })
      }
    }
  } catch {
    // Missing or unreadable: this process starts from what it sees next.
  }
  stores.set(folder, store)
  return store
}

function observations(folder: string, taskId: string): Stored {
  const store = storeFor(folder)
  let current = store.get(taskId)
  if (!current) store.set(taskId, (current = emptyStored()))
  return current
}

function writeObservations(folder: string) {
  const file = join(folder, OBSERVATIONS_FILE)
  const body: ObservationFile = { version: 1, tasks: Object.fromEntries(storeFor(folder)) }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  return writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`).then(() => rename(temporary, file))
}

/** One writer at a time per folder, so two tasks cannot tear the same file. The snapshot is taken when the write runs. */
function schedulePersist(folder: string): Promise<void> {
  const next = (persistChains.get(folder) ?? Promise.resolve()).catch(() => {}).then(() => writeObservations(folder))
  persistChains.set(folder, next)
  return next
}

function enqueue(folder: string, taskId: string, work: () => Promise<void>): Promise<void> {
  const key = `${folder}\0${taskId}`
  const next = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
  chains.set(key, next)
  return next
}

function gitEnv() {
  return agentEnvironment() as NodeJS.ProcessEnv
}

function headNow(cwd: string): string | null {
  try {
    const head = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: gitEnv(), timeout: 10_000 }).trim()
    return head || null
  } catch {
    return null
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { env: gitEnv(), timeout: 3_000, killSignal: 'SIGKILL' })
  return stdout.trim()
}

async function commitsAfter(cwd: string, from: string): Promise<string[]> {
  try {
    const out = await git(cwd, 'rev-list', `${from}..HEAD`)
    return out ? out.split('\n').filter(Boolean) : []
  } catch {
    return []
  }
}

/**
 * Records a user message on the task agent. The plan approval is not an
 * intervention. Messages BusyBoy sends itself (a restart resume) are not either.
 * Counts stay in memory immediately, so the turn that follows can see them.
 */
export function observeTaskMessage({
  folder,
  task,
  approval,
  system,
}: {
  folder: string
  task: RememberTask
  approval: boolean
  system: boolean
}) {
  if (task.kind === 'subagent' || system) return
  const obs = observations(folder, task.id)
  const now = new Date().toISOString()
  if (approval && !obs.approvedAt) {
    obs.approvedAt = now
    const head = headNow(task.worktree)
    obs.approvedHead = head
    obs.turnStart = head
  } else {
    obs.messages.push(now)
    if (obs.approvedAt && !obs.turnStart) obs.turnStart = headNow(task.worktree)
  }
  void schedulePersist(folder).catch((error: unknown) => console.error(`busyboy: could not save remember notes for ${task.id}`, error))
}

/** A turn ended. Agent commits from the turn are recorded, and a finished task is written. */
export function observeTaskTurn({
  folder,
  task,
  root,
  interrupted,
}: {
  folder: string
  task: RememberTask
  root: string
  interrupted: boolean
}): Promise<void> {
  if (task.kind === 'subagent') return Promise.resolve()
  return enqueue(folder, task.id, async () => {
    const obs = observations(folder, task.id)
    if (interrupted) obs.interruptions.push(new Date().toISOString())
    if (obs.turnStart) {
      for (const sha of await commitsAfter(task.worktree, obs.turnStart)) {
        if (!obs.agentCommits.includes(sha)) obs.agentCommits.push(sha)
      }
      obs.turnStart = null
    }
    await schedulePersist(folder).catch(() => {})
    await writeRemember({ folder, task, root, finishedByHand: false })
  })
}

/** The user put the task away. Write the record even when STATUS.md never said done. */
export function finishRememberRecord({ folder, task, root }: { folder: string; task: RememberTask; root: string }): Promise<void> {
  if (task.kind === 'subagent') return Promise.resolve()
  return enqueue(folder, task.id, () => writeRemember({ folder, task, root, finishedByHand: true }))
}

// ---- Counts ------------------------------------------------------------------

/** End state items: `##` headings under `# Success criteria`, or light-form `Done when` lines. */
export function endStateItems(align: string): EndStateItem[] {
  const lines = visibleLines(align)
  const start = lines.findIndex((line) => /^# Success criteria\s*$/i.test(line))
  if (start !== -1) {
    const rest = lines.slice(start + 1)
    const end = rest.findIndex((line) => /^# /.test(line))
    const section = end === -1 ? rest : rest.slice(0, end)
    return section.flatMap((line) => {
      const heading = /^##\s+(.+?)\s*#*$/.exec(line)
      if (!heading) return []
      const label = heading[1].trim()
      const id = /^(\d+[a-z]?)\s*·/i.exec(label)?.[1] ?? null
      return [{ label, id }]
    })
  }
  return lines.flatMap((line) => {
    const done = /^- Done when:\s*(.*)$/.exec(line)
    return done ? [{ label: done[1].trim() || line.trim(), id: null }] : []
  })
}

function visibleLines(text: string): string[] {
  let inFence = false
  const lines: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const fence = /^\s*(```|~~~)/.test(raw)
    if (!inFence && !fence) lines.push(raw.replace(/\s+$/, ''))
    if (fence) inFence = !inFence
  }
  return lines
}

const MET = /^\W*(pass|passed|ok|met|proven)\b/i

function tableCells(text: string): string[] | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('|')) return null
  return trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function norm(text: string) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function matchesItem(cell: string, item: EndStateItem) {
  const value = norm(cell)
  if (!value) return false
  if (item.label && value.includes(norm(item.label))) return true
  return item.id !== null && value === item.id.toLowerCase()
}

/** How many end state items VERIFY.md records as met. An item with no result is unmet. */
export function endStateItemsMet(verify: string | null, items: EndStateItem[]): number {
  if (!verify || items.length === 0) return 0
  const met = items.map(() => false)
  const lines = visibleLines(verify)
  let header: string[] | null = null
  for (let index = 0; index < lines.length; index++) {
    const cells = tableCells(lines[index])
    if (!cells) {
      const bullet = /^-\s+(.+?):\s+(.+)$/.exec(lines[index])
      if (bullet) applyResult(met, items, bullet[1], bullet[2])
      continue
    }
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue
    const next = tableCells(lines[index + 1] ?? '')
    if (next && next.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      header = cells
      continue
    }
    if (!header) continue
    const itemColumn = header.findIndex((cell) => /criteri|item|end state|done when/i.test(cell))
    const resultColumn = header.findIndex((cell) => /^(result|status)$/i.test(cell))
    if (itemColumn === -1 || resultColumn === -1) continue
    applyResult(met, items, cells[itemColumn] ?? '', cells[resultColumn] ?? '')
  }
  return met.filter(Boolean).length
}

/** The last result for an item wins, so a later verify replaces an earlier one. */
function applyResult(met: boolean[], items: EndStateItem[], cell: string, result: string) {
  items.forEach((item, index) => {
    if (matchesItem(cell, item)) met[index] = MET.test(result.trim())
  })
}

function afterApproval(obs: Stored, at: string) {
  return obs.approvedAt === null || at > obs.approvedAt
}

async function manualCommits(task: RememberTask, obs: Stored): Promise<number> {
  const base = obs.approvedHead ?? (obs.approvedAt === null ? await branchPoint(task.worktree) : null)
  if (!base) return 0
  const agent = new Set(obs.agentCommits)
  const commits = await commitsAfter(task.worktree, base)
  return commits.filter((sha) => !agent.has(sha)).length
}

async function branchPoint(cwd: string): Promise<string | null> {
  for (const name of ['main', 'master']) {
    try {
      const tip = await git(cwd, 'rev-parse', '--verify', `${name}^{commit}`)
      const base = await git(cwd, 'merge-base', 'HEAD', tip)
      if (base) return base
    } catch {
      // That branch is not in this repository.
    }
  }
  return null
}

/**
 * Distinct changes a human asked for on the task's pull request.
 * Approvals, bots, and the agent's own REVIEW.md findings are not changes.
 * No pull request, or no way to ask GitHub, is zero.
 */
async function reviewChangeRequests(worktree: string): Promise<number> {
  // Test journeys use a fake origin. Asking `gh` from the server there never finds a pull
  // request, and a stuck CLI must not hold up the record.
  if (process.env.BUSYBOY_TEST_MODE === '1') return 0
  let origin = ''
  try {
    origin = await git(worktree, 'remote', 'get-url', 'origin')
  } catch {
    return 0
  }
  const repo = repoFromOrigin(origin)
  if (!repo) return 0
  let branch = ''
  try {
    branch = await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')
  } catch {
    return 0
  }
  if (!branch || branch === 'HEAD') return 0
  const view = await ghJson<{
    number?: number
    reviews?: { id?: number | string; state?: string; body?: string; author?: { login?: string } }[]
  }>(worktree, ['pr', 'view', branch, '--json', 'number,reviews'])
  if (!view) return 0
  const reviews = view.reviews ?? []
  let comments: { id?: number; pull_request_review_id?: number; body?: string; user?: { login?: string; type?: string } }[] = []
  if (view.number) {
    const listed = await ghJson<typeof comments>(worktree, ['api', '--paginate', `repos/${repo.join('/')}/pulls/${view.number}/comments`])
    if (Array.isArray(listed)) comments = listed
  }
  const humanComments = comments.filter((comment) => isHumanLogin(comment.user?.login, comment.user?.type) && comment.body?.trim())
  const reviewsWithComments = new Set(humanComments.map((comment) => comment.pull_request_review_id).filter((id) => id !== undefined))
  let count = humanComments.length
  for (const review of reviews) {
    if (!isHumanLogin(review.author?.login)) continue
    if (review.id !== undefined && reviewsWithComments.has(Number(review.id))) continue
    const state = review.state ?? ''
    if (state !== 'CHANGES_REQUESTED' && state !== 'COMMENTED') continue
    if (state === 'CHANGES_REQUESTED' || review.body?.trim()) count += 1
  }
  return count
}

function isHumanLogin(login: string | undefined, type?: string) {
  if (!login || type === 'Bot' || /\[bot\]$/i.test(login)) return false
  return true
}

function repoFromOrigin(url: string): string[] | null {
  const cleaned = url.trim().replace(/\.git$/i, '').replace(/\/+$/, '')
  if (!cleaned) return null
  let path = cleaned
  const scp = /^[^/\s]+@[^:\s]+:(.+)$/.exec(cleaned)
  if (scp) path = scp[1]
  else if (cleaned.includes('://')) {
    try {
      path = new URL(cleaned).pathname
    } catch {
      return null
    }
  }
  const parts = path.split('/').filter(Boolean).slice(-2)
  if (parts.length !== 2 || parts.some((part) => part === '.' || part === '..')) return null
  return parts
}

const GH_WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
const { spawn } = require('node:child_process')
const child = spawn('gh', workerData.args, { cwd: workerData.cwd, env: workerData.env, stdio: ['ignore', 'pipe', 'ignore'] })
let out = ''
child.stdout.on('data', (chunk) => { out += chunk })
const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
const finish = (text) => { clearTimeout(timer); parentPort.postMessage(text) }
child.on('error', () => finish(null))
child.on('close', (code) => finish(code === 0 ? out : null))
`

/**
 * Asks `gh` from a worker so a stuck CLI cannot hold up the record.
 * Stdin is closed. No answer within two seconds counts as no pull request.
 */
function ghText(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let worker: Worker
    try {
      worker = new Worker(GH_WORKER, {
        eval: true,
        workerData: { cwd, args, env: { ...gitEnv(), GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } },
      })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      void worker.terminate()
      resolve(null)
    }, 2_500)
    worker.once('message', (text: string | null) => {
      clearTimeout(timer)
      void worker.terminate()
      resolve(text)
    })
    worker.once('error', () => {
      clearTimeout(timer)
      void worker.terminate()
      resolve(null)
    })
  })
}

async function ghJson<T>(cwd: string, args: string[]): Promise<T | null> {
  const stdout = await ghText(cwd, args)
  if (!stdout) return null
  try {
    return JSON.parse(stdout) as T
  } catch {
    return null
  }
}

function delegationReasons(interventions: number, total: number, met: number): string[] {
  const reasons: string[] = []
  if (interventions > 0) reasons.push('interventions_after_approval')
  if (met !== total) reasons.push('end_state_incomplete')
  return reasons
}

// ---- Writing -----------------------------------------------------------------

async function readRecord(worktree: string, taskId: string, file: string): Promise<string | null> {
  const path = join(worktree, '.jwn', taskId, file)
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function repoSegments(task: RememberTask): Promise<string[]> {
  try {
    const origin = await git(task.worktree, 'remote', 'get-url', 'origin')
    const fromOrigin = repoFromOrigin(origin)
    if (fromOrigin) return fromOrigin
  } catch {
    // No origin: the directory that holds the git dir names the repo.
  }
  try {
    const common = await git(task.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    const name = basename(dirname(common))
    if (name && name !== '.' && name !== '..') return [name]
  } catch {
    // Not a git checkout: the project name is the last resort.
  }
  return [task.project || 'task']
}

function insideRoot(root: string, path: string) {
  const fromRoot = relative(root, path)
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))
}

async function writeRemember({
  folder,
  task,
  root,
  finishedByHand,
}: {
  folder: string
  task: RememberTask
  root: string
  finishedByHand: boolean
}) {
  const align = await readRecord(task.worktree, task.id, 'ALIGN.md')
  const items = endStateItems(align ?? '')
  // The delegation-rate script rejects a total below 1, so a task with no end state is not recorded.
  if (items.length < 1) return
  const status = await readRecord(task.worktree, task.id, 'STATUS.md')
  const done = parseRecords(status === null ? {} : { 'STATUS.md': status }).state === 'done'
  if (!done && !finishedByHand) return

  const obs = observations(folder, task.id)
  // ALIGN can say approved when this process missed the Approve message. The file's mtime is
  // when the agent saved that status, which is the approval turn, so later user messages still count.
  if (!obs.approvedAt && align && /^(?:\W*Version:[^·\n]*·)?\W*Status:\s*approved\b/im.test(align)) {
    const stats = await lstat(join(task.worktree, '.jwn', task.id, 'ALIGN.md')).catch(() => null)
    obs.approvedAt = stats?.mtime.toISOString() ?? null
  }
  const messages = obs.messages.filter((at) => afterApproval(obs, at)).length
  const interruptions = obs.interruptions.filter((at) => afterApproval(obs, at)).length
  const manual = await manualCommits(task, obs)
  const interventions = messages + interruptions + manual
  const met = endStateItemsMet(await readRecord(task.worktree, task.id, 'VERIFY.md'), items)
  const changes = await reviewChangeRequests(task.worktree)
  const delegated = interventions === 0 && met === items.length
  const reasons = delegationReasons(interventions, items.length, met)
  if (!obs.finishedOn) obs.finishedOn = localIsoDate()

  const segments = await repoSegments(task)
  const directory = join(root, ...segments, task.id)
  const path = join(directory, REMEMBER_FILE)
  if (!insideRoot(root, path)) return
  await mkdir(directory, { recursive: true })
  const versionPath = join(root, VERSION_FILE)
  if (!(await lstat(versionPath).then(() => true, () => false))) {
    await writeFile(versionPath, `${RECORD_VERSION}\n`)
  }
  const text = renderRemember({
    date: obs.finishedOn,
    interventions,
    total: items.length,
    met,
    changes,
    delegated,
    messages,
    interruptions,
    manual,
    approvedAt: obs.approvedAt,
    reasons,
  })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, text)
  await rename(temporary, path)
  await schedulePersist(folder).catch(() => {})
}

function renderRemember(input: {
  date: string
  interventions: number
  total: number
  met: number
  changes: number
  delegated: boolean
  messages: number
  interruptions: number
  manual: number
  approvedAt: string | null
  reasons: string[]
}) {
  const found = (yes: boolean, evidence: string) => (yes ? `found. ${evidence}` : 'not found.')
  return [
    '---',
    `date: ${input.date}`,
    `interventions_after_approval: ${input.interventions}`,
    `end_state_items_total: ${input.total}`,
    `end_state_items_met: ${input.met}`,
    `review_change_requests: ${input.changes}`,
    `delegated: ${input.delegated ? 'true' : 'false'}`,
    '---',
    '',
    '# Remember',
    '',
    input.delegated ? 'No observed problem.' : `Not delegated: ${input.reasons.join(', ')}.`,
    '',
    '## Evidence',
    '',
    `- Approval: ${input.approvedAt ?? 'none recorded'}`,
    `- User messages after approval: ${input.messages}`,
    `- Interruptions after approval: ${input.interruptions}`,
    `- Manual commits after approval: ${input.manual}`,
    `- End state items met: ${input.met} of ${input.total}`,
    `- Pull request change requests: ${input.changes}`,
    '',
    '## Failures',
    '',
    `- End state not reached: ${found(input.reasons.includes('end_state_incomplete'), `VERIFY.md records ${input.met} of ${input.total} end state items met.`)}`,
    `- Result rejected: ${found(input.changes > 0, `${input.changes} human change request${input.changes === 1 ? '' : 's'} on the pull request.`)}`,
    `- Process rejected: ${found(input.reasons.includes('interventions_after_approval'), `${input.interventions} intervention${input.interventions === 1 ? '' : 's'} after approval.`)}`,
    '- Needless ask: not yet observable.',
    '- Missed ask: not yet observable.',
    '- Ignored preference or rule: not yet observable.',
    '',
    '## Proposals',
    '',
    'None.',
    '',
  ].join('\n')
}

// ---- Week --------------------------------------------------------------------

type Civil = { y: number; m: number; d: number }

function daysFromCivil(y: number, m: number, d: number): number {
  let year = y
  if (m <= 2) year -= 1
  const era = year >= 0 ? Math.floor(year / 400) : Math.floor((year - 399) / 400)
  const yoe = year - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

function civilFromDays(z: number): Civil {
  let days = z + 719468
  const era = days >= 0 ? Math.floor(days / 146097) : Math.floor((days - 146096) / 146097)
  const doe = days - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  let y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp < 10 ? mp + 3 : mp - 9
  if (m <= 2) y += 1
  return { y, m, d }
}

function isoDow(days: number): number {
  let dow = (days + 3) % 7
  if (dow < 0) dow += 7
  return dow + 1
}

function isoWeekOf(y: number, m: number, d: number): { year: number; week: number } {
  const days = daysFromCivil(y, m, d)
  const thursday = days + (4 - isoDow(days))
  const civil = civilFromDays(thursday)
  const doy = thursday - daysFromCivil(civil.y, 1, 1) + 1
  return { year: civil.y, week: Math.floor((doy - 1) / 7) + 1 }
}

function ymd(civil: Civil): string {
  return `${String(civil.y).padStart(4, '0')}-${String(civil.m).padStart(2, '0')}-${String(civil.d).padStart(2, '0')}`
}

function mondayOf(year: number, week: number): number {
  const january4 = daysFromCivil(year, 1, 4)
  return january4 - (isoDow(january4) - 1) + (week - 1) * 7
}

/** Monday-through-Sunday bounds of a local ISO week. The default week is the current one. */
export function isoWeekRange(week?: string, today = localIsoDate()): { week: string; weekStart: string; weekEnd: string } {
  let year: number
  let weekNumber: number
  if (week === undefined) {
    const [y, m, d] = today.split('-').map(Number)
    const current = isoWeekOf(y, m, d)
    year = current.year
    weekNumber = current.week
  } else {
    if (!/^\d{4}-W\d{2}$/.test(week)) throw new Error(`Week must look like 2026-W03, not ${week}.`)
    year = Number(week.slice(0, 4))
    weekNumber = Number(week.slice(6))
    if (weekNumber < 1 || weekNumber > 53) throw new Error(`Week must look like 2026-W03, not ${week}.`)
  }
  const monday = civilFromDays(mondayOf(year, weekNumber))
  const check = isoWeekOf(monday.y, monday.m, monday.d)
  if (check.year !== year || check.week !== weekNumber) throw new Error(`${year}-W${String(weekNumber).padStart(2, '0')} is not an ISO week.`)
  const sunday = civilFromDays(mondayOf(year, weekNumber) + 6)
  return {
    week: `${String(year).padStart(4, '0')}-W${String(weekNumber).padStart(2, '0')}`,
    weekStart: ymd(monday),
    weekEnd: ymd(sunday),
  }
}

type FrontMatter = {
  date: string
  interventionsAfterApproval: number
  endStateItemsTotal: number
  endStateItemsMet: number
  reviewChangeRequests: number
  delegated: boolean
}

/** Parses front matter the way the delegation-rate script does. A string reason means it would reject the file. */
export function parseRememberFrontMatter(text: string): FrontMatter | string {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (!/^---[ \t]*$/.test(lines[0] ?? '')) return 'missing front matter'
  const seen = new Map<string, string>()
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index].replace(/\s+$/, '')
    if (/^---[ \t]*$/.test(line)) break
    if (index === lines.length - 1) return 'unclosed front matter'
    if (line.trim() === '') continue
    const match = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line.trim())
    if (!match) return 'bad front matter line'
    if (seen.has(match[1])) return `duplicate field ${match[1]}`
    seen.set(match[1], match[2].trim())
  }
  if (!lines.slice(1).some((line) => /^---[ \t]*$/.test(line))) return 'unclosed front matter'
  if (!seen.has('date')) return 'missing date'
  const date = unquote(seen.get('date') ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !realDate(date)) return 'date must be YYYY-MM-DD'
  const missing = ['interventions_after_approval', 'end_state_items_total', 'end_state_items_met', 'review_change_requests', 'delegated'].filter(
    (key) => !seen.has(key),
  )
  if (missing.length > 0) return `missing ${missing.join(' ')}`
  const numbers = ['interventions_after_approval', 'end_state_items_total', 'end_state_items_met', 'review_change_requests'] as const
  for (const key of numbers) {
    if (!/^(0|[1-9]\d*)$/.test(seen.get(key) ?? '')) return `${key} must be an integer without leading zeros`
  }
  const delegated = seen.get('delegated')
  if (delegated !== 'true' && delegated !== 'false') return 'delegated must be true or false'
  const total = Number(seen.get('end_state_items_total'))
  const met = Number(seen.get('end_state_items_met'))
  const interventions = Number(seen.get('interventions_after_approval'))
  if (total < 1) return 'end_state_items_total must be at least 1'
  if (met > total) return 'end_state_items_met is greater than end_state_items_total'
  const expected = interventions === 0 && met === total ? 'true' : 'false'
  if (delegated !== expected) return `delegated is ${delegated}, want ${expected}`
  return {
    date,
    interventionsAfterApproval: interventions,
    endStateItemsTotal: total,
    endStateItemsMet: met,
    reviewChangeRequests: Number(seen.get('review_change_requests')),
    delegated: delegated === 'true',
  }
}

function unquote(value: string) {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
  }
  return value
}

function realDate(value: string) {
  const [y, m, d] = value.split('-').map(Number)
  const civil = civilFromDays(daysFromCivil(y, m, d))
  return civil.y === y && civil.m === m && civil.d === d
}

async function recordFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (directory: string, depth: number) => {
    if (depth > 8) return
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      // A link could point outside the record root.
      if (entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path, depth + 1)
      else if (entry.isFile() && (entry.name === REMEMBER_FILE || entry.name === LEGACY_REMEMBER_FILE)) found.push(path)
    }
  }
  await walk(root, 0)
  // One record per task. The new name wins when both files are still in the folder.
  const byDirectory = new Map<string, string>()
  for (const path of found) {
    const directory = dirname(path)
    const current = byDirectory.get(directory)
    if (!current || basename(path) === REMEMBER_FILE) byDirectory.set(directory, path)
  }
  return [...byDirectory.values()].sort()
}

/**
 * Records whose `date` falls in one local ISO week. `root` is the record root
 * (`$JWN_HOME` or `~/.jwn`). Pass `YYYY-Www` to select another week.
 */
export async function readRecordsForWeek(root: string, week?: string): Promise<WeekDelegation> {
  const range = isoWeekRange(week)
  const records: DelegationRecord[] = []
  const rejected: { path: string; reason: string }[] = []
  for (const path of await recordFiles(root)) {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      rejected.push({ path, reason: 'could not read the file' })
      continue
    }
    const parsed = parseRememberFrontMatter(text)
    if (typeof parsed !== 'string') {
      if (parsed.date < range.weekStart || parsed.date > range.weekEnd) continue
      records.push({
        path,
        ...parsed,
        reasons: delegationReasons(parsed.interventionsAfterApproval, parsed.endStateItemsTotal, parsed.endStateItemsMet),
      })
      continue
    }
    // The script accepts a valid date before it checks the other fields, and then ignores
    // a directory file whose date is outside the week. A broken date is still an error.
    const date = parsed === 'missing front matter' || parsed === 'unclosed front matter' || parsed === 'date must be YYYY-MM-DD' || parsed === 'missing date' ? null : frontDate(text)
    if (date && (date < range.weekStart || date > range.weekEnd)) continue
    rejected.push({ path, reason: parsed })
  }
  return { ...range, records, rejected }
}

function frontDate(text: string): string | null {
  const match = /^date:[ \t]*['"]?(\d{4}-\d{2}-\d{2})/m.exec(text)
  return match && realDate(match[1]) ? match[1] : null
}
