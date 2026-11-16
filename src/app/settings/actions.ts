'use server'

import { refresh } from 'next/cache'
import type { AlwaysAskResult } from '@/components/setup/always-ask-form'
import { alwaysAskError, saveAlwaysAsk } from '@/server/always-ask-list'
import { chooseCompanion, findCompanion } from '@/server/companions'
import { PROVIDERS, setDefaultProvider } from '@/server/providers'
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

/** Saves the always-ask list from its text box, one rule per line. A line that could never match is refused. */
export async function saveAlwaysAskAction(_previous: AlwaysAskResult, form: FormData): Promise<AlwaysAskResult> {
  const text = form.get('rules')
  const error = alwaysAskError(text)
  if (error) {
    return { error }
  }
  await saveAlwaysAsk(text as string)
  // No refresh: the box already shows what was saved.
  return { saved: true }
}
