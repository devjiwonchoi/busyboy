'use server'

import { dataFolder } from '@/server/config'
import { sendToMaster } from '@/server/master-chat'
import { busyboyMcpServer } from '@/server/mcp-tools'
import { defaultProvider, providerState, PROVIDERS } from '@/server/providers'
import type { ProviderId } from '@/server/runner/contract'

const MAX_MESSAGE_LENGTH = 100_000

/** The provider for the master; null when nobody is signed in, undefined when a sign-in check failed. */
async function resolveMasterProvider(): Promise<ProviderId | null | undefined> {
  const provider = await defaultProvider()
  if (provider) return provider
  const states = await Promise.all(PROVIDERS.map(({ id }) => providerState(id)))
  return states.some(({ state }) => state === 'unknown') ? undefined : null
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
