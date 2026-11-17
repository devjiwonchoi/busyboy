import { readDraftPlan } from './cards/plan'
import { optionLetter, type CardQuestion, type TaskCard } from './cards/model'
import { answerAgent, getAgent, sendMessage, stopAgent, subscribeToAgent } from './runner/agent-runner'
import type { AgentAnswer, AgentEvent, Question } from './runner/contract'

export type { CardOption, CardQuestion, TaskCard } from './cards/model'

// Cards are how a task agent reaches the user: a question, an approval, or a
// plan that waits for approval. They live only while the agent waits. The
// Director chat shows open ones in the timeline and writes each one to its
// transcript once it closes. Progress, done, and pull-request cards use the
// same store through presentCard. A Director connector approval uses it too.

export type CardUpdate = { type: 'open'; card: TaskCard } | { type: 'close'; card: TaskCard; outcome: string }

/** The task fields a card needs; matches `TaskRecord` without importing tasks.ts. */
type CardTask = { id: string; project: string; title: string; agentId: string; worktree: string; chat?: string | null }

/** What the agent receives when the user clicks Approve on an Align card. */
export const APPROVE_MESSAGE = 'Approved.'

export const ALLOW = 'Allow'
export const ALLOW_FOR_SESSION = 'Allow for this session'
export const DENY = 'Deny'

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
    chat: task.chat ?? null,
    project: task.project,
    taskTitle: task.title,
    openedAt: new Date().toISOString(),
  }
  if (event.type === 'question') {
    return { ...source, kind: 'question', questions: event.questions.map(toCardQuestion) }
  }

  const labels = event.canAllowForSession ? [ALLOW, event.allowForSessionLabel ?? ALLOW_FOR_SESSION, DENY] : [ALLOW, DENY]
  const options = labels.map((label) => ({ label, description: undefined, recommended: false }))
  return {
    ...source,
    kind: 'approval',
    detail: event.detail,
    questions: [{ question: event.title, header: undefined, options, multiSelect: false }],
  }
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
        void readDraftPlan(task)
          .then((draft) => {
            // Only while the agent still waits on this turn: a message or stop since then moved on.
            if (!draft || latestSeq !== seq || getAgent(task.agentId)?.status !== 'idle') {
              return
            }
            const card: TaskCard = {
              id: alignId,
              taskId: task.id,
              chat: task.chat ?? null,
              project: task.project,
              taskTitle: task.title,
              openedAt: new Date().toISOString(),
              kind: 'plan',
              ...draft,
            }
            openCard(store, { card, agentId: task.agentId, requestId: null })
          })
          .catch((error: unknown) => console.error(`busyboy: could not read the plan of ${task.id}`, error))
        break
    }
  })
}

/** Shows a Director approval in the chat that owns `chat`, answered through the Director's agent. */
export function openDirectorApproval({
  folder,
  chat,
  agentId,
  event,
}: {
  folder: string
  chat: string | null
  agentId: string
  event: Extract<AgentEvent, { type: 'approval' }>
}) {
  const server = /^mcp__(.+?)__/.exec(event.title)?.[1] ?? 'connector'
  const labels = event.canAllowForSession ? [ALLOW, event.allowForSessionLabel ?? ALLOW_FOR_SESSION, DENY] : [ALLOW, DENY]
  const card: TaskCard = {
    id: `${agentId}:${event.requestId}`,
    taskId: agentId,
    chat,
    project: 'Director',
    taskTitle: server,
    openedAt: new Date().toISOString(),
    stopsTask: false,
    kind: 'approval',
    detail: event.detail,
    questions: [{ question: event.title, header: undefined, options: labels.map((label) => ({ label, description: undefined, recommended: false })), multiSelect: false }],
  }
  openCard(storeFor(folder), { card, agentId, requestId: event.requestId })
}

/** Closes a Director approval that was answered or whose turn ended. */
export function closeDirectorApproval(folder: string, agentId: string, requestId?: string) {
  const store = storeFor(folder)
  for (const [id, entry] of [...store.open]) {
    if (entry.agentId !== agentId || entry.card.stopsTask !== false) continue
    if (requestId !== undefined && id !== `${agentId}:${requestId}`) continue
    closeCard(store, id)
  }
}

export function openCards(folder: string) {
  return [...storeFor(folder).open.values()].map(({ card }) => card)
}

/**
 * Puts a card on the timeline. Sending the same id again replaces that card;
 * keep `openedAt` to leave it where it is. Question, approval, and plan cards
 * are opened by trackTaskCards. Progress, done, and pull-request cards use this.
 * `agentId` is the task agent the card belongs to, so stopping that agent closes it.
 */
export function presentCard({
  folder,
  card,
  agentId,
  requestId = null,
}: {
  folder: string
  card: TaskCard
  agentId: string
  requestId?: string | null
}) {
  openCard(storeFor(folder), { card, agentId, requestId })
}

/** Closes a card with `outcome`, the same path as answering one. */
export function settleCard({ folder, cardId, outcome }: { folder: string; cardId: string; outcome: string }) {
  const store = storeFor(folder)
  if (!store.open.has(cardId)) {
    throw new CardError('This card was already answered.')
  }
  withOutcome(store, cardId, outcome, () => closeCard(store, cardId))
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

/**
 * Answers a question or approval card with the chosen labels for each of its
 * questions, by question index: two questions of one request may share their text.
 */
export function answerCard({ folder, cardId, choices }: { folder: string; cardId: string; choices: string[][] }) {
  const { store, entry } = getOpen(folder, cardId)
  const { card } = entry
  if ((card.kind !== 'question' && card.kind !== 'approval') || !entry.requestId) {
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
  if (card.kind === 'approval') {
    const [label] = picked[0].labels
    // The middle option remembers the allow, whatever the request named it.
    answer = { kind: 'approval', allow: label !== DENY, forSession: label !== ALLOW && label !== DENY }
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

/** Approves the plan, so the task agent carries on with it. */
export function approveCard({ folder, cardId }: { folder: string; cardId: string }) {
  const { store, entry } = getOpen(folder, cardId)
  if (entry.card.kind !== 'plan') {
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
  if (card.kind === 'plan') {
    withOutcome(store, cardId, 'Changes requested', () => sendMessage(entry.agentId, text))
    return
  }
  if (card.kind !== 'question' && card.kind !== 'approval') {
    throw new CardError('This card does not take a reply.')
  }

  const answer: AgentAnswer =
    card.kind === 'approval'
      ? { kind: 'approval', allow: false, message: text }
      : { kind: 'question', answers: Object.fromEntries(card.questions.map(({ question }) => [question, text])) }
  const { agentId, requestId } = entry
  withOutcome(store, cardId, card.kind === 'approval' ? 'Denied with a reply' : 'Answered with a reply', () =>
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

/**
 * Whether a task agent waits on a question, an approval, or a plan, including a
 * plan card while the agent itself is idle. Progress, done, and pull-request
 * cards stay on the timeline without taking the task: the user can still message it.
 */
export function hasOpenCard(agentId: string) {
  return [...stores.values()].some((store) =>
    [...store.open.values()].some(
      (entry) => entry.agentId === agentId && (entry.card.kind === 'question' || entry.card.kind === 'approval' || entry.card.kind === 'plan'),
    ),
  )
}
