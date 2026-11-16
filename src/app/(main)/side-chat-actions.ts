'use server'

import { dataFolder } from '@/server/config'
import { askSideQuestion, closeSideChat } from '@/server/director/side-chat'
import { getManagerAt } from '@/server/managers'

const MAX_QUESTION_LENGTH = 100_000

/**
 * Asks in the side chat `agentId`, or a new one branched from the Director's
 * conversation, or from the manager `chat`'s. Returns the side agent's id;
 * the answer streams from /api/side-chat/<id>/events?after=<after>.
 */
export async function askSideQuestionAction(text: unknown, agentId?: unknown, chat?: unknown): Promise<{ agentId: string; after: number; restarted: boolean } | { error: string }> {
  // Server actions are public endpoints, so the argument is checked at runtime.
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_QUESTION_LENGTH) {
    throw new Error('A question must be non-empty text of at most 100,000 characters.')
  }
  if (agentId !== undefined && (typeof agentId !== 'string' || !agentId || agentId.length > 200)) {
    throw new Error('The agent id must be a non-empty string.')
  }
  if (chat !== undefined && chat !== null && typeof chat !== 'string') throw new Error('The chat must be a manager id.')
  try {
    const folder = await dataFolder()
    if (chat && !(await getManagerAt(folder, chat))) return { error: 'That manager no longer exists.' }
    return await askSideQuestion(folder, text.trim(), agentId, chat || null)
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
