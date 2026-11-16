import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { answerAgent, getAgent, sendMessage, stopAgent, subscribeToAgent } from './runner/agent-runner'
import type { AgentAnswer, AgentEvent, Question } from './runner/contract'

// Cards are how a task agent reaches the user: a choice card for a question or
// an approval, and an Align card for a plan that waits for approval. They live
// only while the agent waits; the Director chat pins open ones above the
// composer and writes each one to its transcript once it closes.

export type CardOption = { label: string; description: string | undefined; recommended: boolean }

export type CardQuestion = { question: string; header: string | undefined; options: CardOption[]; multiSelect: boolean }

type CardSource = { id: string; taskId: string; project: string; taskTitle: string; openedAt: string }

export type TaskCard = CardSource &
  (
    | {
        kind: 'choice'
        /** An approval card offers Allow / Allow for this session / Deny as its one question. */
        approval: boolean
        /** Extra context for an approval, such as the full command. */
        detail: string | undefined
        questions: CardQuestion[]
      }
    | {
        kind: 'align'
        title: string
        /** Two or three sentences on the goal and end state. */
        summary: string
        /** The whole ALIGN.md, for View details. */
        plan: string
      }
  )

export type CardUpdate = { type: 'open'; card: TaskCard } | { type: 'close'; card: TaskCard; outcome: string }

/** The task fields a card needs; matches `TaskRecord` without importing tasks.ts. */
type CardTask = { id: string; project: string; title: string; agentId: string; worktree: string }

/** What the agent receives when the user clicks Approve on an Align card. */
export const APPROVE_MESSAGE = 'Approved.'

export const ALLOW = 'Allow'
export const ALLOW_FOR_SESSION = 'Allow for this session'
export const DENY = 'Deny'

/**
 * The plan's own status, at the start of a line or after `Version: <n> ·` as the
 * align template writes it, so prose that mentions an approval never counts.
 */
const APPROVED = /^(?:\W*Version:[^·\n]*·)?\W*Status:\s*approved\b/im

/** Agents mark the option they recommend this way (AskUserQuestion's own convention). */
const RECOMMENDED = /\s*\(recommended\)\s*$/i

type OpenCard = { card: TaskCard; agentId: string; requestId: string | null }

type CardStore = {
  open: Map<string, OpenCard>
  /** Outcomes set by an action just before the event that closes its card. */
  outcomes: Map<string, string>
  listeners: Set<(update: CardUpdate) => void>
}

// On globalThis for the same reason as the runner's registry: `next dev` reloads.
const STORE_KEY = Symbol.for('busyboy.task-cards')
const globalStore = globalThis as typeof globalThis & { [STORE_KEY]?: Map<string, CardStore> }
const stores = (globalStore[STORE_KEY] ??= new Map())

function storeFor(folder: string): CardStore {
  let store = stores.get(folder)
  if (!store) {
    store = { open: new Map(), outcomes: new Map(), listeners: new Set() }
    stores.set(folder, store)
  }
  return store
}

function openCard(store: CardStore, entry: OpenCard) {
  store.open.set(entry.card.id, entry)
  for (const listener of store.listeners) listener({ type: 'open', card: entry.card })
}

function closeCard(store: CardStore, cardId: string) {
  const entry = store.open.get(cardId)
  if (!entry) {
    return
  }
  store.open.delete(cardId)
  // Closed without an action of ours: answered elsewhere, interrupted, or the agent ended.
  const outcome = store.outcomes.get(cardId) ?? 'No longer waiting'
  store.outcomes.delete(cardId)
  for (const listener of store.listeners) listener({ type: 'close', card: entry.card, outcome })
}

function toCardQuestion({ question, header, options, multiSelect }: Question): CardQuestion {
  return {
    question,
    header,
    multiSelect,
    options: options.map(({ label, description }) => ({
      label: label.replace(RECOMMENDED, ''),
      description,
      recommended: RECOMMENDED.test(label),
    })),
  }
}

function requestCard(task: CardTask, event: Extract<AgentEvent, { type: 'approval' | 'question' }>): TaskCard {
  const source = {
    id: `${task.agentId}:${event.requestId}`,
    taskId: task.id,
    project: task.project,
    taskTitle: task.title,
    openedAt: new Date().toISOString(),
  }
  if (event.type === 'question') {
    return { ...source, kind: 'choice', approval: false, detail: undefined, questions: event.questions.map(toCardQuestion) }
  }

  const labels = event.canAllowForSession ? [ALLOW, ALLOW_FOR_SESSION, DENY] : [ALLOW, DENY]
  const options = labels.map((label) => ({ label, description: undefined, recommended: false }))
  return {
    ...source,
    kind: 'choice',
    approval: true,
    detail: event.detail,
    questions: [{ question: event.title, header: undefined, options, multiSelect: false }],
  }
}

/**
 * The body of a top-level `# <name>` section, up to the next top-level heading.
 * Code fences are not tracked, so a `# comment` line in a fence ends the
 * section early; that only shortens the card's summary, and View details shows the whole plan.
 */
function topSection(text: string, name: string) {
  const match = new RegExp(`^#\\s+${name}\\s*$([\\s\\S]*?)(?=^#\\s|(?![\\s\\S]))`, 'im').exec(text)
  return match?.[1] ?? ''
}

/**
 * Two or three sentences for the Align card: the Goal's prose and the
 * Summary's "What" line, which the align template states in both forms.
 */
export function alignSummary(plan: string) {
  const goal = topSection(plan, 'Goal')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph && !/^(intention:|---)/i.test(paragraph))
    .join(' ')
  const what = /^\s*-\s*What:\s*(.+)$/im.exec(topSection(plan, 'Summary'))?.[1].trim()
  const sentences = [goal, what ? `When done: ${what}` : '']
    .join(' ')
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
  const summary = sentences.slice(0, 3).join(' ')
  return /[.!?]$/.test(summary) || !summary ? summary : `${summary}.`
}

/** A draft plan waiting for approval, read when the agent ends a turn. Null when there is none. */
async function draftPlan(task: CardTask) {
  const plan = await readFile(join(task.worktree, '.jwn', task.id, 'ALIGN.md'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  if (plan === null || APPROVED.test(plan)) {
    return null
  }

  const title = /^#\s+ALIGN:\s*(.+?)\s*$/m.exec(plan)?.[1] ?? task.title
  return { title, plan, summary: alignSummary(plan) }
}

/** Opens and closes the cards of one task agent for as long as it runs; `onChange` follows each open and close. */
export function trackTaskCards({ folder, task, onChange }: { folder: string; task: CardTask; onChange: () => void }) {
  const store = storeFor(folder)
  const isOwn = (update: CardUpdate) => update.card.taskId === task.id
  store.listeners.add((update) => {
    if (isOwn(update)) {
      onChange()
    }
  })
  const alignId = `align:${task.id}`
  let latestSeq = 0

  subscribeToAgent(task.agentId, 0, ({ seq, event }) => {
    latestSeq = seq
    switch (event.type) {
      case 'approval':
      case 'question':
        openCard(store, { card: requestCard(task, event), agentId: task.agentId, requestId: event.requestId })
        break
      case 'answered':
        closeCard(store, `${task.agentId}:${event.requestId}`)
        break
      case 'user-message':
      case 'started':
      case 'stopped':
        closeCard(store, alignId)
        break
      case 'turn-done':
        if (event.more) {
          break
        }
        void draftPlan(task)
          .then((draft) => {
            // Only while the agent still waits on this turn: a message or stop since then moved on.
            if (!draft || latestSeq !== seq || getAgent(task.agentId)?.status !== 'idle') {
              return
            }
            const card: TaskCard = {
              id: alignId,
              taskId: task.id,
              project: task.project,
              taskTitle: task.title,
              openedAt: new Date().toISOString(),
              kind: 'align',
              ...draft,
            }
            openCard(store, { card, agentId: task.agentId, requestId: null })
          })
          .catch((error: unknown) => console.error(`busyboy: could not read the plan of ${task.id}`, error))
        break
    }
  })
}

export function openCards(folder: string) {
  return [...storeFor(folder).open.values()].map(({ card }) => card)
}

export function subscribeToCards(folder: string, listener: (update: CardUpdate) => void) {
  const store = storeFor(folder)
  store.listeners.add(listener)
  return () => store.listeners.delete(listener)
}

export class CardError extends Error {}

/**
 * Runs an action that closes a card with `outcome`. The outcome is set first
 * because the runner closes the card synchronously inside the action; it is
 * removed again when the action fails, so it cannot label a later card with the same id.
 */
function withOutcome(store: CardStore, cardId: string, outcome: string, action: () => boolean | void) {
  store.outcomes.set(cardId, outcome)
  let delivered: boolean | void
  try {
    delivered = action()
  } catch (error) {
    store.outcomes.delete(cardId)
    throw error
  }
  if (delivered === false) {
    store.outcomes.delete(cardId)
    throw new CardError('This card was already answered.')
  }
}

function getOpen(folder: string, cardId: string) {
  const store = storeFor(folder)
  const entry = store.open.get(cardId)
  if (!entry) {
    throw new CardError('This card was already answered.')
  }
  return { store, entry }
}

/** Letters the options of a question: A, B, C… */
export function optionLetter(index: number) {
  return String.fromCharCode(65 + index)
}

/**
 * Answers a choice card with the chosen labels for each of its questions, by
 * question index: two questions of one request may share their text.
 */
export function answerCard({ folder, cardId, choices }: { folder: string; cardId: string; choices: string[][] }) {
  const { store, entry } = getOpen(folder, cardId)
  const { card } = entry
  if (card.kind !== 'choice' || !entry.requestId) {
    throw new CardError('Only a question or approval card takes a choice.')
  }

  const picked = card.questions.map(({ question, options, multiSelect }, index) => {
    const labels = [...new Set(choices[index] ?? [])]
    const valid = labels.length > 0 && (multiSelect || labels.length === 1) && labels.every((label) => options.some((option) => option.label === label))
    if (!valid) {
      throw new CardError(`Choose an answer for "${question}".`)
    }
    return { question, labels, letters: labels.map((label) => optionLetter(options.findIndex((option) => option.label === label))) }
  })

  let answer: AgentAnswer
  if (card.approval) {
    const [label] = picked[0].labels
    answer = { kind: 'approval', allow: label !== DENY, forSession: label === ALLOW_FOR_SESSION }
  } else {
    // The providers key answers by question text, so questions that share their text share one answer, listing both choices.
    const answers: Record<string, string> = {}
    for (const { question, labels } of picked) {
      answers[question] = Object.hasOwn(answers, question) ? `${answers[question]}; ${labels.join(', ')}` : labels.join(', ')
    }
    answer = { kind: 'question', answers }
  }
  const outcome = picked.map(({ labels, letters }) => labels.map((label, index) => `${letters[index]} · ${label}`).join(', ')).join('; ')
  const { agentId, requestId } = entry
  withOutcome(store, cardId, outcome, () => answerAgent(agentId, requestId, answer))
}

/** Approves the plan of an Align card, so the task agent carries on with it. */
export function approveCard({ folder, cardId }: { folder: string; cardId: string }) {
  const { store, entry } = getOpen(folder, cardId)
  if (entry.card.kind !== 'align') {
    throw new CardError('Only a plan card can be approved.')
  }
  withOutcome(store, cardId, 'Approved', () => sendMessage(entry.agentId, APPROVE_MESSAGE))
}

/**
 * Sends the user's reply to the card's task agent: a requested change for a
 * plan, a written answer for a question, or the reason for a refused approval.
 */
export function replyToCard({ folder, cardId, text }: { folder: string; cardId: string; text: string }) {
  const { store, entry } = getOpen(folder, cardId)
  const { card } = entry
  if (card.kind === 'align') {
    withOutcome(store, cardId, 'Changes requested', () => sendMessage(entry.agentId, text))
    return
  }

  const answer: AgentAnswer = card.approval
    ? { kind: 'approval', allow: false, message: text }
    : { kind: 'question', answers: Object.fromEntries(card.questions.map(({ question }) => [question, text])) }
  const { agentId, requestId } = entry
  withOutcome(store, cardId, card.approval ? 'Denied with a reply' : 'Answered with a reply', () =>
    requestId ? answerAgent(agentId, requestId, answer) : false,
  )
}

/** Stops a task agent; its open cards close as stopped. */
export async function stopTaskAgent({ folder, agentId }: { folder: string; agentId: string }) {
  // A task from an earlier run of the app has no agent in this one, so it is already stopped.
  if (!getAgent(agentId)) {
    return
  }
  const store = storeFor(folder)
  const cardIds = [...store.open.values()].filter((entry) => entry.agentId === agentId).map(({ card }) => card.id)
  for (const cardId of cardIds) {
    store.outcomes.set(cardId, 'Stopped')
  }
  try {
    await stopAgent(agentId)
  } catch (error) {
    for (const cardId of cardIds) {
      store.outcomes.delete(cardId)
    }
    throw error
  }
}

/** Whether a task agent waits on one of its cards, including a plan card while the agent itself is idle. */
export function hasOpenCard(agentId: string) {
  return [...stores.values()].some((store) => [...store.open.values()].some((entry) => entry.agentId === agentId))
}
