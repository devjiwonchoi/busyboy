// Reads the Markdown records a task agent's jwn skills keep under
// `.jwn/<task>/`. The skills fix only a few headings and labels, so this reads
// by heading and line, skips fenced code, and reports anything it cannot read
// as a RecordError instead of guessing: the graph then shows an error node, so
// a record it misreads never turns into a quietly wrong status.

export const RECORD_FILES = ['ALIGN.md', 'STATUS.md', 'VERIFY.md', 'REVIEW.md'] as const
export type RecordFile = (typeof RECORD_FILES)[number]

/** The text of each record file that exists, or the error reading it. */
export type RecordTexts = Partial<Record<RecordFile, string | { error: string }>>

/** `.jwn` when the record folder itself cannot be found. */
export type RecordError = { file: RecordFile | '.jwn'; message: string }

/** What STATUS.md says about the whole task. */
export type RecordState = 'running' | 'needs-you' | 'done' | 'stopped' | 'planning'

export type TodoResult = 'running' | 'needs-you' | 'done' | 'stopped' | 'not-started'

export type ParsedTodo = { id: string; title: string; goal: string | null; result: TodoResult; resultText: string | null }

export type BuildsOn = { project: string; task: string }

export type ParsedRecords = {
  title: string | null
  approved: boolean
  stage: string | null
  state: RecordState | null
  stateText: string | null
  todos: ParsedTodo[]
  buildsOn: BuildsOn[]
  checks: { passed: number; failed: number; pending: number }
  openFindings: number
  errors: RecordError[]
}

type Line = { text: string; inFence: boolean }

const FENCE = /^\s*(```|~~~)/

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
  return match ? { level: match[1].length, title: match[2] } : null
}

/** The lines under the first level-1 heading named `name`, up to the next level-1 heading. */
function section(lines: Line[], name: string) {
  const start = lines.findIndex((line) => {
    const heading = headingOf(line)
    return heading?.level === 1 && heading.title.trim().toLowerCase() === name
  })
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => headingOf(line)?.level === 1)
  return end === -1 ? rest : rest.slice(0, end)
}

function firstMatch(lines: Line[], pattern: RegExp) {
  for (const line of lines) {
    if (line.inFence) continue
    const match = pattern.exec(line.text)
    if (match) return match
  }
  return null
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

const isSeparatorRow = (cells: string[]) => cells.every((cell) => /^:?-{3,}:?$/.test(cell))

function allMatches(lines: Line[], pattern: RegExp) {
  return lines.flatMap((line) => (line.inFence ? [] : [pattern.exec(line.text)?.[1]])).filter((value) => value !== undefined)
}

/**
 * Every table data row with the header of its table. A row is a header when a
 * separator row follows it; rows that continue a table after a paragraph keep
 * the last header, so they are still read instead of skipped.
 */
function tableRows(lines: Line[]) {
  const rows: { header: string[]; cells: string[] }[] = []
  let header: string[] | null = null
  lines.forEach((line, index) => {
    const cells = line.inFence ? null : tableCells(line.text)
    if (!cells || isSeparatorRow(cells)) return
    const next = lines[index + 1]
    const nextCells = next && !next.inFence ? tableCells(next.text) : null
    if (nextCells && isSeparatorRow(nextCells)) header = cells
    else if (header) rows.push({ header, cells })
  })
  return rows
}

// ---- ALIGN.md ---------------------------------------------------------------

/** A todo heading in the align template: `## 2a · Title        (subagent)`. */
const TODO_HEADING = /^(\d+[a-z]?)\s*·\s*(.+?)(?:\s{2,}\(.*\))?\s*$/i

/**
 * `Builds on: <project>/<task>[, ...]` is busyboy's own line (the skills have
 * none): a task that continues another project's task names it here, and the
 * graph draws a dashed edge between the two.
 */
const BUILDS_ON = /^\s*(?:-\s*)?Builds on:\s*(.+)$/i

function parseAlign(text: string, errors: RecordError[]) {
  const lines = toLines(text)
  const title = firstMatch(lines, /^#\s+ALIGN:\s*(.+?)\s*$/)?.[1] ?? null
  if (title === null) errors.push({ file: 'ALIGN.md', message: "The first heading '# ALIGN: <title>' is missing." })
  const approved = firstMatch(lines, /Status:\s*approved\b/i) !== null

  const todos: Omit<ParsedTodo, 'result' | 'resultText'>[] = []
  for (const line of section(lines, 'todos') ?? []) {
    const heading = headingOf(line)
    if (heading?.level === 2) {
      const todo = TODO_HEADING.exec(heading.title)
      if (todo) todos.push({ id: todo[1].toLowerCase(), title: todo[2].trim(), goal: null })
      else errors.push({ file: 'ALIGN.md', message: `The todo heading "${heading.title}" has no "<number> · <title>" form.` })
      continue
    }
    const goal = /^\s*-\s*Goal:\s*(.+)$/i.exec(line.text)
    const current = todos.at(-1)
    if (goal && current && current.goal === null && !line.inFence) current.goal = goal[1].trim()
  }

  const buildsOn: BuildsOn[] = []
  const buildsOnLine = firstMatch(lines, BUILDS_ON)
  for (const part of buildsOnLine?.[1].split(/[,;]/) ?? []) {
    const target = /^\s*`?([^\s`/]+)\/([^\s`/]+?)`?\.?\s*$/.exec(part)
    if (target) buildsOn.push({ project: target[1], task: target[2] })
    else if (!/^\s*none\.?\s*$/i.test(part)) {
      errors.push({ file: 'ALIGN.md', message: `Could not read "${part.trim()}" in Builds on; write it as <project>/<task>.` })
    }
  }

  return { title, approved, todos, buildsOn }
}

// ---- STATUS.md --------------------------------------------------------------

// The recording rules ask an agent to end each turn by saying whether it is
// continuing, waiting on something, needing the user, or done.
const STATE_PATTERNS: [RegExp, RecordState][] = [
  [/^(done|complete|completed|finished|merged|shipped)\b/i, 'done'],
  [/^(needs? (the )?user|needing (the )?user|needs you|waiting (on|for) (the )?user|asking)\b/i, 'needs-you'],
  [/^(stopped|failed|failing|cancell?ed|abandoned|paused|on hold)\b/i, 'stopped'],
  [/^(draft|planning|aligning)\b/i, 'planning'],
  [/^(continuing|running|in progress|implementing|iterating|verifying|reviewing|shipping|waiting|blocked)\b/i, 'running'],
]

const RESULT_PATTERNS: [RegExp, TodoResult][] = [
  [/^(done|complete|completed|passed|merged|shipped)\b/i, 'done'],
  [/^(needs? (the )?user|needs you|waiting (on|for) (the )?user|asking)\b/i, 'needs-you'],
  [/^(failed|failing|stopped|cancell?ed|abandoned)\b/i, 'stopped'],
  [/^(running|in progress|re-?run|re-?running|implementing|verifying|reviewing|fixing)\b/i, 'running'],
  [/^(not started|pending|todo|waits on|waiting|blocked)\b|^[\s—-]*$/i, 'not-started'],
]

/** Todo ids at the start of a table cell or bullet: `2`, `0 + 1 scaffold`, `2a, 2b`. */
function todoIds(text: string) {
  const match = /^\s*(?:todos?\s+)?((?:\d+[a-z]?)(?:\s*[+,&]\s*\d+[a-z]?)*)\b/i.exec(text.replace(/[*`]/g, ''))
  return match ? match[1].split(/\s*[+,&]\s*/).map((id) => id.toLowerCase()) : []
}

function parseStatus(text: string, errors: RecordError[]) {
  const lines = toLines(text)
  const stage = firstMatch(lines, /^\s*(?:-\s*)?Stage:\s*(.+?)\s*$/i)?.[1] ?? null
  // The record keeps one current state; several different ones (history left above) cannot be told apart.
  const states = [...new Set(allMatches(lines, /^\s*(?:-\s*)?State:\s*(.+?)\s*$/i))]
  if (states.length > 1) errors.push({ file: 'STATUS.md', message: `There are ${states.length} different 'State:' lines; keep only the current one.` })
  const stateText = states.length === 1 ? states[0] : null
  let state: RecordState | null = null
  if (stateText !== null) {
    state = STATE_PATTERNS.find(([pattern]) => pattern.test(stateText))?.[1] ?? null
    if (state === null) errors.push({ file: 'STATUS.md', message: `The state "${stateText}" is not one busyboy knows.` })
  } else if (states.length === 0 && stage === null) {
    errors.push({ file: 'STATUS.md', message: "There is no 'State:' or 'Stage:' line." })
  }

  // Todo results: a table with a todo column and a result column, or `- Todo 2: done` bullets.
  const results = new Map<string, string>()
  const record = (id: string, result: string) => {
    const known = results.get(id)
    if (known !== undefined && known !== result) {
      errors.push({ file: 'STATUS.md', message: `Todo ${id} has two results, "${known}" and "${result}".` })
    }
    results.set(id, result)
  }
  for (const line of lines) {
    const bullet = line.inFence ? null : /^\s*-\s*Todo\s+([^:]+):\s*(.*)$/i.exec(line.text)
    if (bullet) for (const id of todoIds(bullet[1])) record(id, bullet[2].trim())
  }
  for (const { header, cells } of tableRows(lines)) {
    const todo = header.findIndex((cell) => /^todos?$/i.test(cell))
    const result = header.findIndex((cell) => /^(result|status|state)$/i.test(cell))
    if (todo === -1 || result === -1) continue
    for (const id of todoIds(cells[todo] ?? '')) record(id, cells[result] ?? '')
  }
  return { stage, state, stateText, results }
}

function todoResult(id: string, text: string | undefined, errors: RecordError[]): TodoResult {
  if (text === undefined) return 'not-started'
  const result = RESULT_PATTERNS.find(([pattern]) => pattern.test(text))?.[1]
  if (result) return result
  errors.push({ file: 'STATUS.md', message: `The result of todo ${id}, "${text}", is not one busyboy knows.` })
  return 'not-started'
}

// ---- VERIFY.md and REVIEW.md -------------------------------------------------

/** Counts criterion rows in VERIFY.md tables by their result column. */
function parseVerify(text: string) {
  const checks = { passed: 0, failed: 0, pending: 0 }
  for (const { header, cells } of tableRows(toLines(text))) {
    const result = header.some((cell) => /criteri/i.test(cell)) ? header.findIndex((cell) => /^(result|status)$/i.test(cell)) : -1
    if (result === -1) continue
    const value = cells[result] ?? ''
    if (/^\W*(pass|passed|ok|met|proven)\b/i.test(value)) checks.passed++
    else if (/^\W*(fail|failed|not met)\b/i.test(value)) checks.failed++
    else checks.pending++
  }
  return checks
}

// A finding's status is read by its first word, so "reopened (was resolved)"
// or "open; partially fixed" stays open. Bullets have no status cell, so any
// open word in the line keeps them open.
const OPEN_STATUS = /^\W*(open|reopened|new|unresolved|not)\b/i
const CLOSED_STATUS = /^\W*(resolved|fixed|dismissed|accepted|won['’]?t fix|dropped|closed)\b/i
const OPEN_WORD = /\b(open|reopened|unresolved|not (yet )?resolved|partially)\b/i
const CLOSED_WORD = /\b(resolved|fixed|dismissed|accepted|won['’]?t fix|dropped|closed)\b/i

/** Counts review findings (`R1`-style ids in a table or bullets) not marked resolved or dismissed. */
function parseReview(text: string, errors: RecordError[]) {
  const open = new Map<string, boolean>()
  const lines = toLines(text)
  for (const line of lines) {
    const bullet = line.inFence ? null : /^\s*-\s+\**([A-Z]{1,3}\d+)\b(.*)$/.exec(line.text)
    if (bullet) open.set(bullet[1], OPEN_WORD.test(bullet[2]) || !CLOSED_WORD.test(bullet[2]))
  }
  for (const { header, cells } of tableRows(lines)) {
    const idColumn = header.findIndex((cell) => /^id$/i.test(cell))
    const statusColumn = header.findIndex((cell) => /^status$/i.test(cell))
    const id = cells[idColumn] ?? ''
    if (idColumn === -1 || !/^[A-Z]{1,3}\d+$/.test(id)) continue
    const status = statusColumn === -1 ? 'open' : (cells[statusColumn] ?? '')
    if (OPEN_STATUS.test(status)) open.set(id, true)
    else if (CLOSED_STATUS.test(status)) open.set(id, false)
    else {
      errors.push({ file: 'REVIEW.md', message: `The status of ${id}, "${status}", is not one busyboy knows.` })
      open.set(id, true)
    }
  }
  return [...open.values()].filter(Boolean).length
}

// ---- One task's records ------------------------------------------------------

function textOf(texts: RecordTexts, file: RecordFile, errors: RecordError[]) {
  const value = texts[file]
  if (value === undefined || typeof value === 'string') return value ?? null
  errors.push({ file, message: `Could not read the file: ${value.error}` })
  return null
}

export function parseRecords(texts: RecordTexts): ParsedRecords {
  const errors: RecordError[] = []
  const alignText = textOf(texts, 'ALIGN.md', errors)
  const statusText = textOf(texts, 'STATUS.md', errors)
  const verifyText = textOf(texts, 'VERIFY.md', errors)
  const reviewText = textOf(texts, 'REVIEW.md', errors)

  const align = alignText === null ? null : parseAlign(alignText, errors)
  const status = statusText === null ? null : parseStatus(statusText, errors)
  const todos = (align?.todos ?? []).map((todo) => {
    const resultText = status?.results.get(todo.id)
    return { ...todo, result: todoResult(todo.id, resultText, errors), resultText: resultText ?? null }
  })
  // A finished task whose todos all read as not started means the results are written in a form this cannot read.
  if (status?.state === 'done' && todos.length > 0 && todos.every(({ resultText }) => resultText === null)) {
    errors.push({ file: 'STATUS.md', message: "The task is done but no todo has a result; use a '| Todo | Result |' table." })
  }

  return {
    title: align?.title ?? null,
    approved: align?.approved ?? false,
    stage: status?.stage ?? null,
    // A STATUS.md with only a stage still tells the graph the task is under way.
    state: status ? (status.state ?? (status.stage ? 'running' : null)) : null,
    stateText: status?.stateText ?? null,
    todos,
    buildsOn: align?.buildsOn ?? [],
    checks: verifyText === null ? { passed: 0, failed: 0, pending: 0 } : parseVerify(verifyText),
    openFindings: reviewText === null ? 0 : parseReview(reviewText, errors),
    errors,
  }
}
