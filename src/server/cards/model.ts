import type { TaskPhase } from '../records/task-phase'


export const CARD_KINDS = ['plan', 'progress', 'done', 'pr', 'question', 'approval'] as const

export type CardKind = (typeof CARD_KINDS)[number]

export const LEGACY_CARD_KINDS = ['choice', 'align'] as const

export type StoredCardKind = CardKind | (typeof LEGACY_CARD_KINDS)[number]

const STORED_CARD_KINDS = new Set<string>([...CARD_KINDS, ...LEGACY_CARD_KINDS])

export function isStoredCardKind(value: unknown): value is StoredCardKind {
  return typeof value === 'string' && STORED_CARD_KINDS.has(value)
}

export type CardOption = { label: string; description: string | undefined; recommended: boolean }

export type CardQuestion = { question: string; header: string | undefined; options: CardOption[]; multiSelect: boolean }

type CardBase = {
  id: string
  taskId: string
  chat: string | null
  project: string
  taskTitle: string
  openedAt: string
  stopsTask?: false
}

export type ProgressStepState = 'done' | 'running' | 'pending'

export type ProgressStep = { id: string; label: string; state: ProgressStepState }

export type PullRequestCheck = 'passing' | 'failing' | 'pending' | 'none'

export type PullRequestRow = {
  number: number
  title: string
  url: string
  check: PullRequestCheck
  review: string
}

export type TaskCard = CardBase &
  (
    | { kind: 'question'; questions: CardQuestion[] }
    | {
        kind: 'approval'
        detail: string | undefined
        questions: CardQuestion[]
      }
    | {
        kind: 'plan'
        title: string
        summary: string
        plan: string
        criteria: string[]
      }
    | { kind: 'progress'; title: string; steps: ProgressStep[]; phase: TaskPhase }
    | {
        kind: 'done'
        title: string
        achievement: { met: number; agreed: number } | null
        phase: TaskPhase
        pendingChecks: number
      }
    | { kind: 'pr'; title: string; note?: string; pulls: PullRequestRow[] }
  )

export type QuestionCard = Extract<TaskCard, { kind: 'question' }>
export type ApprovalCard = Extract<TaskCard, { kind: 'approval' }>
export type PlanCard = Extract<TaskCard, { kind: 'plan' }>
export type ProgressCard = Extract<TaskCard, { kind: 'progress' }>
export type DoneCard = Extract<TaskCard, { kind: 'done' }>
export type PrCard = Extract<TaskCard, { kind: 'pr' }>

const KIND_LABEL: Record<CardKind, string> = {
  plan: 'Plan',
  progress: 'Progress',
  done: 'Done',
  pr: 'Pull requests',
  question: 'Question',
  approval: 'Approval',
}

export function cardGroupLabel(card: TaskCard) {
  return `${KIND_LABEL[card.kind]} from ${card.project} · ${card.taskTitle}`
}

export function cardRecordTitle(card: TaskCard) {
  switch (card.kind) {
    case 'plan':
      return `Plan: ${card.title}`
    case 'progress':
    case 'done':
    case 'pr':
      return card.title
    case 'question':
    case 'approval':
      return card.questions.map(({ question }) => question).join(' ')
    default: {
      const exhaustive: never = card
      return exhaustive
    }
  }
}

export function optionLetter(index: number) {
  return String.fromCharCode(65 + index)
}
