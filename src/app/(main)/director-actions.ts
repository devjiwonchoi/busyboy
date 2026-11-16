'use server'

import { dataFolder } from '@/server/config'
import { replyToTaskCard, sendToDirector, stopDirector } from '@/server/director/chat'
import { busyboyMcpServers } from '@/server/mcp-tools'
import { defaultProvider, providerState } from '@/server/providers'
import type { ProviderId } from '@/server/runner/contract'
import { answerCard, approveCard } from '@/server/task-cards'
import { stopTask } from '@/server/tasks'

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

export async function sendToDirectorAction(text: string) {
  // Server actions are public endpoints, so the argument is checked at runtime.
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_MESSAGE_LENGTH) {
    throw new Error('A message must be non-empty text of at most 100,000 characters.')
  }
  await sendToDirector({
    folder: await dataFolder(),
    text,
    resolveProvider: resolveDirectorProvider,
    mcp: await busyboyMcpServers(),
  })
}

export async function stopDirectorAction() {
  await stopDirector(await dataFolder())
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

/** Sends a composer message to the task agent behind an open card instead of the Director. */
export async function replyToCardAction(cardId: string, text: string) {
  checkId(cardId, 'The card')
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_MESSAGE_LENGTH) {
    throw new Error('A message must be non-empty text of at most 100,000 characters.')
  }
  await replyToTaskCard({ folder: await dataFolder(), cardId, text })
}

export async function stopTaskAction(taskId: string) {
  checkId(taskId, 'The task')
  await stopTask(taskId)
}
