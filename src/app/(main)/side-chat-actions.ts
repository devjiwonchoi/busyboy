'use server'

import { dataFolder } from '@/server/config'
import { askSideQuestion, closeSideChat } from '@/server/director/side-chat'

const MAX_QUESTION_LENGTH = 100_000

/**
 * Asks in the side chat `agentId`, or a new one. Returns the side agent's id;
 * the answer streams from /api/side-chat/<id>/events?after=<after>.
 */
export async function askSideQuestionAction(text: unknown, agentId?: unknown): Promise<{ agentId: string; after: number; restarted: boolean } | { error: string }> {
  // Server actions are public endpoints, so the argument is checked at runtime.
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_QUESTION_LENGTH) {
    throw new Error('A question must be non-empty text of at most 100,000 characters.')
  }
  if (agentId !== undefined && (typeof agentId !== 'string' || !agentId || agentId.length > 200)) {
    throw new Error('The agent id must be a non-empty string.')
  }
  try {
    return await askSideQuestion(await dataFolder(), text.trim(), agentId)
  } catch (error) {
    // Returned, not thrown: production builds hide thrown messages from the client.
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Ends the side chat with this agent id. */
export async function closeSideChatAction(agentId: unknown) {
  if (typeof agentId !== 'string' || !agentId) throw new Error('The agent id must be a non-empty string.')
  await closeSideChat(await dataFolder(), agentId)
}
