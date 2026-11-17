'use server'

import { writeChatHarness, type ChatHarness } from '@/server/chat-harness'
import { dataFolder } from '@/server/config'
import { DIRECTOR_FOLDER, MANAGERS_FOLDER } from '@/server/director/chat'
import { getManagerAt } from '@/server/managers'
import { join } from 'node:path'

/** The manager a chat id names, or null for the Director. Throws when the manager is gone. */
async function checkChat(chat: unknown) {
  if (chat === null || chat === undefined) return null
  if (typeof chat !== 'string' || !(await getManagerAt(await dataFolder(), chat))) throw new Error('That manager no longer exists.')
  return chat
}

/** Saves the harness, model, and effort for one chat. An empty model or effort uses the harness default. */
export async function setChatHarnessAction(chat: unknown, choice: unknown): Promise<ChatHarness> {
  const manager = await checkChat(chat)
  const folder = await dataFolder()
  // The chat id is chosen at runtime. Ignore it for the file trace; the folder is the data directory.
  const directory = manager
    ? join(/*turbopackIgnore: true*/ folder, MANAGERS_FOLDER, manager)
    : join(/*turbopackIgnore: true*/ folder, DIRECTOR_FOLDER)
  return writeChatHarness(directory, choice)
}
