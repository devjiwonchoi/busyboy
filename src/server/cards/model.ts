// The timeline card. Question, approval, and plan cards are opened by a task
// agent (task-cards.ts). Progress, done, and pull-request cards are opened by
// later work through presentCard; their fields are fixed here so that work
// does not have to change this union.

export const CARD_KINDS = ['plan', 'progress', 'done', 'pr', 'question', 'approval'] as const

export type CardKind = (typeof CARD_KINDS)[number]

/** Kinds written into transcripts before this model. Still readable, never written. */
export const LEGACY_CARD_KINDS = ['choice', 'align'] as const

export type StoredCardKind = CardKind | (typeof LEGACY_CARD_KINDS)[number]

const STORED_CARD_KINDS = new Set<string>([...CARD_KINDS, ...LEGACY_CARD_KINDS])

export function isStoredCardKind(value: unknown): value is StoredCardKind {
  return typeof value === 'string' && STORED_CARD_KINDS.has(value)
}

export type CardOption = { label: string; description: string | undefined; recommended: boolean }

export type CardQuestion = { question: string; header: string | undefined; options: CardOption[]; multiSelect: boolean }

/** `chat`: the manager whose chat shows the card; null for the Director's. */
type CardBase = {
  id: string
  taskId: string
  chat: string | null
  project: string
  taskTitle: string
  openedAt: string
  /** Set when the card is not a task's, so the timeline does not offer Stop task. */
  stopsTask?: false
}

export type ProgressStepState = 'done' | 'running' | 'pending'

export type ProgressStep = { id: string; label: string; state: ProgressStepState }

/** CI for one pull request row. `none` draws no dot. */
export type PullRequestCheck = 'passing' | 'failing' | 'pending' | 'none'

export type PullRequestRow = {
  number: number
  title: string
  url: string
  check: PullRequestCheck
  /** Review status, on the right of the row. */
  review: string
}

export type TaskCard = CardBase &
  (
    | { kind: 'question'; questions: CardQuestion[] }
    | {
        kind: 'approval'
        /** Extra context, such as the full command. */
        detail: string | undefined
        questions: CardQuestion[]
      }
    | {
        kind: 'plan'
        title: string
        /** Two or three sentences on the goal and end state. */
        summary: string
        /** The whole ALIGN.md, shown in the details dialog. */
        plan: string
        /**
         * End-state lines. Empty until the plan follow-up fills them from ALIGN.md;
         * the card shows `summary` until then.
         */
        criteria: string[]
      }
    | { kind: 'progress'; title: string; steps: ProgressStep[] }
    | {
        kind: 'done'
        title: string
        /**
         * Share of agreed end-state items met (records on main). Null when this
         * task has no agreed end state there.
         */
        achievement: { met: number; agreed: number } | null
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

/** The accessible name of an open card: "Plan from web · Add a footer". */
export function cardGroupLabel(card: TaskCard) {
  return `${KIND_LABEL[card.kind]} from ${card.project} · ${card.taskTitle}`
}

/** The title stored on the transcript line when a card closes. */
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

/** Letters the options of a question: A, B, C… */
export function optionLetter(index: number) {
  return String.fromCharCode(65 + index)
}
