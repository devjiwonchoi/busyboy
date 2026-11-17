import type { CardKind } from '../cards/model'
import type { ParsedRecords } from './parse-records'
import type { TaskStatus } from '../tasks'


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

function verifying(records: PhaseRecords) {
  if (VERIFYING.test(textOf(records))) return true
  return records.todos.length > 0 && records.todos.every((todo) => todo.result === 'done') && records.checks.pending > 0
}

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
