'use server'

import { refresh } from 'next/cache'
import { saveAlwaysAsk } from '@/server/always-ask-list'
import { chooseCompanion, findCompanion } from '@/server/companions'
import { PROVIDERS, setDefaultProvider } from '@/server/providers'
import { ruleError } from '@/server/runner/always-ask'
import type { ProviderId } from '@/server/runner/contract'

// Settings save where they are changed: no step to finish and nowhere to go on to.
// Server actions are public endpoints, so every argument is checked at runtime.

export async function setCompanionAction(id: unknown) {
  if (typeof id !== 'string' || !findCompanion(id)) throw new Error('Unknown companion.')
  await chooseCompanion(id)
  refresh()
}

export async function setDefaultProviderAction(id: unknown) {
  if (!PROVIDERS.some((provider) => provider.id === id)) throw new Error('Unknown provider.')
  await setDefaultProvider(id as ProviderId)
  refresh()
}

export type SaveResult = { error?: string; saved?: boolean }

const MAX_ALWAYS_ASK_LENGTH = 20_000

/** Saves the always-ask list from its text box, one rule per line. A line that could never match is refused. */
export async function saveAlwaysAskAction(_previous: SaveResult, form: FormData): Promise<SaveResult> {
  const text = form.get('rules')
  if (typeof text !== 'string' || text.length > MAX_ALWAYS_ASK_LENGTH) {
    return { error: 'Keep the list under 20,000 characters.' }
  }
  const error = text.split('\n').map(ruleError).find(Boolean)
  if (error) {
    return { error }
  }
  await saveAlwaysAsk(text)
  // No refresh: the box already shows what was saved, and the page keys the form by the saved
  // list (so Restore defaults shows the defaults), which would remount it and drop "Saved.".
  return { saved: true }
}
