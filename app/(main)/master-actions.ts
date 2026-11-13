'use server'

import { dataFolder } from '@/server/config'
import { sendToMaster } from '@/server/master-chat'
import { busyboyMcpServer } from '@/server/mcp-tools'
import { defaultProvider } from '@/server/providers'

const MAX_MESSAGE_LENGTH = 100_000

export async function sendToMasterAction(text: string) {
  // Server actions are public endpoints, so the argument is checked at runtime.
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_MESSAGE_LENGTH) {
    throw new Error('A message must be non-empty text of at most 100,000 characters.')
  }
  await sendToMaster({
    folder: await dataFolder(),
    text,
    provider: await defaultProvider(),
    mcp: await busyboyMcpServer(),
  })
}
