'use server'

import { dataFolder } from '@/server/config'
import { sendToMaster } from '@/server/master-chat'
import { busyboyMcpServer } from '@/server/mcp-tools'
import { defaultProvider, providerState } from '@/server/providers'
import type { ProviderId } from '@/server/runner/contract'

const MAX_MESSAGE_LENGTH = 100_000

/**
 * The provider for the master's next turn. The provider the master already
 * uses carries on only when its own sign-in check failed, never when it is
 * known to be signed out. Null when no provider can be used.
 */
async function resolveMasterProvider(current?: ProviderId): Promise<ProviderId | null> {
  const provider = await defaultProvider()
  if (provider) return provider
  if (current && (await providerState(current)).state === 'unknown') return current
  return null
}

export async function sendToMasterAction(text: string) {
  // Server actions are public endpoints, so the argument is checked at runtime.
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_MESSAGE_LENGTH) {
    throw new Error('A message must be non-empty text of at most 100,000 characters.')
  }
  await sendToMaster({
    folder: await dataFolder(),
    text,
    resolveProvider: resolveMasterProvider,
    mcp: await busyboyMcpServer(),
  })
}
