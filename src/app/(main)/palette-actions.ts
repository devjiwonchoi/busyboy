'use server'

import { commandPalette, type PaletteChat, type SearchHit } from '@/server/search-chats'

const QUERY_LIMIT = 200

/** Chats to switch to, and transcript or task hits for a query. */
export async function commandPaletteAction(query: unknown): Promise<{ chats: PaletteChat[]; hits: SearchHit[] }> {
  const text = typeof query === 'string' ? query.slice(0, QUERY_LIMIT) : ''
  return commandPalette(text)
}
