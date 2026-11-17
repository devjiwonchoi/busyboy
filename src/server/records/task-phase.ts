import type { CardKind } from '../cards/model'
import type { ParsedRecords } from './parse-records'
import type { TaskStatus } from '../tasks'

// One place a task is in its work, derived from the records and the open cards.
// The project graph, the task row, and the timeline cards all say this word.

export const TASK_PHASES = ['planning', 'aligning', 'working', 'verifying', 'needs-you', 'pr', 'done', 'stopped', 'idle'] as const

export type TaskPhase = (typeof TASK_PHASES)[number]

export const PHASE_WORD: Record<TaskPhase, string> = {
  planning: 'Planning',
  aligning: 'Aligning',
  working: 'Working',
  verifying: 'Verifying',
  'needs-you': 'Needs you',
  pr: 'PR',
  done: 'Done',
  stopped: 'Stopped',
  idle: 'Idle',
}

export type PhaseRecords = Pick<ParsedRecords, 'approved' | 'state' | 'stateText' | 'stage' | 'todos' | 'checks'>

const VERIFYING = /\b(verify(?:ing)?|review(?:ing)?)\b/i
const ALIGNING = /\baligning\b/i
const BLOCKED = /\bblocked\b/i

function textOf(records: PhaseRecords) {
  return `${records.stage ?? ''}\n${records.stateText ?? ''}`
}

/** The record is in verification: its stage or state says so, or every todo is done and a check is still pending. */
function verifying(records: PhaseRecords) {
  if (VERIFYING.test(textOf(records))) return true
  return records.todos.length > 0 && records.todos.every((todo) => todo.result === 'done') && records.checks.pending > 0
}

/**
 * Where the task is. A plan card is Aligning, a question or an approval is Needs you,
 * and a finished task with an open pull request is PR. An idle agent whose record
 * still says running is Working or Verifying, not someone waiting.
 */
export function taskPhase({
  agent,
  records,
  cards,
  resumeFailed,
}: {
  agent: TaskStatus
  records: PhaseRecords
  cards: readonly CardKind[]
  resumeFailed: boolean
}): TaskPhase {
  if (resumeFailed && records.state !== 'done') return 'stopped'
  if (records.state === 'done') return cards.includes('pr') ? 'pr' : 'done'
  if (cards.includes('question') || cards.includes('approval')) return 'needs-you'
  if (cards.includes('plan')) return 'aligning'
  if (records.state === 'needs-you' || BLOCKED.test(records.stateText ?? '')) return 'needs-you'
  if (agent === 'needs-you') return 'needs-you'
  if (records.state === 'stopped' || agent === 'stopped') return 'stopped'
  if (verifying(records)) return 'verifying'
  if (records.state === 'planning' || (agent === 'running' && !records.approved && records.state !== 'running')) {
    return ALIGNING.test(records.stateText ?? '') ? 'aligning' : 'planning'
  }
  if (records.state === 'running' || agent === 'running') return 'working'
  return 'idle'
}
