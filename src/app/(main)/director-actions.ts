'use server'

import { dataFolder } from '@/server/config'
import { sendToDirector, stopDirector } from '@/server/director/chat'
import { busyboyMcpServers } from '@/server/mcp-tools'
import { defaultProvider, providerState } from '@/server/providers'
import type { ProviderId } from '@/server/runner/contract'

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
