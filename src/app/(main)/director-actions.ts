'use server'

import type { AttachmentInput } from '@/lib/chat-attachments'
import { AttachmentError } from '@/server/chat-attachments'
import { dataFolder } from '@/server/config'
import { replyToTaskCard, reviseDirectorMessage, sendDirectorQueueNow, sendToDirector, sendToTask, stopDirector } from '@/server/director/chat'
import { getManagerAt } from '@/server/managers'
import { busyboyMcpServers } from '@/server/mcp-tools'
import { defaultProvider, providerState } from '@/server/providers'
import type { ProviderId } from '@/server/runner/contract'
import { mergePullRequests, readTaskPlan } from '@/server/cards/work-cards'
import { answerCard, approveCard } from '@/server/task-cards'
import { archiveTask, restoreTask, stopTask, TaskError } from '@/server/tasks'

const MAX_MESSAGE_LENGTH = 100_000

/**
 * The provider for the Director's next turn. The provider the Director already
 * uses carries on only when its own sign-in check failed, never when it is
 * known to be signed out. Null when no provider can be used.
 */
async function resolveDirectorProvider(current?: ProviderId): Promise<ProviderId | null> {
  const provider = await defaultProvider()
  if (provider) return provider
  if (current && (await providerState(current)).state === 'unknown') return current
  return null
}

/** The manager a chat id names, or null for the Director's chat. Throws for a manager that does not exist. */
async function checkChat(chat: unknown) {
  if (chat === null || chat === undefined) return null
  if (typeof chat !== 'string' || !(await getManagerAt(await dataFolder(), chat))) throw new Error('That manager no longer exists.')
  return chat
}

function attachmentInputs(value: unknown): AttachmentInput[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new AttachmentError('Attachments must be a list of files.')
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new AttachmentError('An attachment is missing its name or contents.')
    const record = item as Record<string, unknown>
    if (typeof record.name !== 'string' || typeof record.mediaType !== 'string' || typeof record.data !== 'string') {
      throw new AttachmentError('An attachment is missing its name or contents.')
    }
    return { name: record.name, mediaType: record.mediaType, data: record.data }
  })
}

/** Sends a message to the Director, or to the manager `chat`. */
export async function sendToDirectorAction(text: string, chat?: string | null, attachments?: AttachmentInput[]): Promise<{ error?: string }> {
  // Server actions are public endpoints, so the argument is checked at runtime.
  if (typeof text !== 'string' || text.length > MAX_MESSAGE_LENGTH) {
    throw new Error('A message must be non-empty text of at most 100,000 characters.')
  }
  try {
    const files = attachmentInputs(attachments)
    if (!text.trim() && files.length === 0) throw new Error('A message must be non-empty text of at most 100,000 characters.')
    const manager = await checkChat(chat)
    await sendToDirector({
      folder: await dataFolder(),
      chat: manager,
      text,
      attachments: files,
      resolveProvider: resolveDirectorProvider,
      mcp: await busyboyMcpServers(undefined, undefined, manager ?? undefined),
    })
    return {}
  } catch (error) {
    if (error instanceof AttachmentError) return { error: error.message }
    throw error
  }
}

export async function stopDirectorAction(chat?: string | null) {
  await stopDirector(await dataFolder(), await checkChat(chat))
}

/** Interrupts the current reply and sends the messages waiting behind it. */
export async function sendDirectorQueueNowAction(chat?: string | null) {
  await sendDirectorQueueNow(await dataFolder(), await checkChat(chat))
}

/**
 * Replaces the latest message in the chat with `text` and asks again.
 * Server actions are public endpoints, so every argument is checked at runtime.
 */
export async function reviseDirectorMessageAction(
  entryId: string,
  text: string,
  chat?: string | null,
  attachments?: AttachmentInput[],
): Promise<{ error?: string }> {
  checkId(entryId, 'The message')
  if (typeof text !== 'string' || text.length > MAX_MESSAGE_LENGTH) {
    throw new Error('A message must be non-empty text of at most 100,000 characters.')
  }
  try {
    const files = attachmentInputs(attachments)
    if (!text.trim() && files.length === 0) throw new Error('A message must be non-empty text of at most 100,000 characters.')
    const manager = await checkChat(chat)
    await reviseDirectorMessage({
      folder: await dataFolder(),
      chat: manager,
      entryId,
      text,
      attachments: files,
      resolveProvider: resolveDirectorProvider,
      mcp: await busyboyMcpServers(undefined, undefined, manager ?? undefined),
    })
    return {}
  } catch (error) {
    if (error instanceof AttachmentError) return { error: error.message }
    throw error
  }
}

// Server actions are public endpoints, so every argument is checked at runtime.
function checkId(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 500) {
    throw new Error(`${name} must be a non-empty id.`)
  }
}

/** Answers a choice card: the chosen option labels for each of its questions, in question order. */
export async function answerCardAction(cardId: string, choices: string[][]) {
  checkId(cardId, 'The card')
  const valid =
    Array.isArray(choices) && choices.every((labels) => Array.isArray(labels) && labels.every((label) => typeof label === 'string'))
  if (!valid) {
    throw new Error('Choices must list the chosen option labels of each question, in order.')
  }
  answerCard({ folder: await dataFolder(), cardId, choices })
}

export async function approveCardAction(cardId: string) {
  checkId(cardId, 'The card')
  approveCard({ folder: await dataFolder(), cardId })
}

/** The task's saved plan, for a done card's View plan link. Null when it has none. */
export async function readTaskPlanAction(taskId: string) {
  checkId(taskId, 'The task')
  return readTaskPlan({ folder: await dataFolder(), taskId })
}

/** Merges the pull requests on an open card, base of the stack first. Nothing merges until this runs. */
export async function mergePullRequestsAction(cardId: string) {
  checkId(cardId, 'The card')
  await mergePullRequests({ folder: await dataFolder(), cardId })
}

/** Sends a composer message to the task agent behind an open card instead of the Director. */
export async function replyToCardAction(cardId: string, text: string, attachments?: AttachmentInput[]): Promise<{ error?: string }> {
  checkId(cardId, 'The card')
  if (typeof text !== 'string' || text.length > MAX_MESSAGE_LENGTH) {
    throw new Error('A message must be non-empty text of at most 100,000 characters.')
  }
  try {
    const files = attachmentInputs(attachments)
    if (!text.trim() && files.length === 0) throw new Error('A message must be non-empty text of at most 100,000 characters.')
    await replyToTaskCard({ folder: await dataFolder(), cardId, text, attachments: files })
    return {}
  } catch (error) {
    if (error instanceof AttachmentError) return { error: error.message }
    throw error
  }
}

export async function stopTaskAction(taskId: string) {
  checkId(taskId, 'The task')
  await stopTask(taskId)
}

/**
 * Sends a composer message to a task's agent instead of the Director. A refusal the user can act
 * on (the task waits on a card, its worktree is gone) comes back as `error`: a thrown error's
 * message does not reach the window in a production build.
 */
export async function messageTaskAction(taskId: string, text: string, attachments?: AttachmentInput[]): Promise<{ error?: string }> {
  checkId(taskId, 'The task')
  if (typeof text !== 'string' || text.length > MAX_MESSAGE_LENGTH) {
    throw new Error('A message must be non-empty text of at most 100,000 characters.')
  }
  try {
    const files = attachmentInputs(attachments)
    if (!text.trim() && files.length === 0) throw new Error('A message must be non-empty text of at most 100,000 characters.')
    await sendToTask({ folder: await dataFolder(), taskId, text, attachments: files })
    return {}
  } catch (error) {
    if (error instanceof AttachmentError || error instanceof TaskError) return { error: error.message }
    throw error
  }
}

/** Archives a task. `worktreeKept` says its worktree stayed because it has uncommitted changes. */
export async function archiveTaskAction(taskId: string): Promise<{ error?: string; worktreeKept?: boolean }> {
  checkId(taskId, 'The task')
  try {
    return { worktreeKept: (await archiveTask(taskId)).worktreeKept }
  } catch (error) {
    if (error instanceof TaskError) return { error: error.message }
    throw error
  }
}

export async function restoreTaskAction(taskId: string): Promise<{ error?: string }> {
  checkId(taskId, 'The task')
  try {
    await restoreTask(taskId)
    return {}
  } catch (error) {
    if (error instanceof TaskError) return { error: error.message }
    throw error
  }
}
