'use server'

import { refresh } from 'next/cache'
import type { AlwaysAskResult } from '@/components/setup/always-ask-form'
import { alwaysAskError, saveAlwaysAsk } from '@/server/always-ask-list'
import { chooseCompanion, findCompanion } from '@/server/companions'
import { updateSettings } from '@/server/config'
import { addConnector } from '@/server/connectors'
import { isThemeName } from '@/lib/theme'
import { PROVIDERS, setDefaultProvider } from '@/server/providers'
import type { ProviderId } from '@/server/runner/contract'


export async function setCompanionAction(id: unknown) {
  if (typeof id !== 'string' || !findCompanion(id)) throw new Error('Unknown director.')
  await chooseCompanion(id)
  refresh()
}

export async function setThemeAction(theme: unknown) {
  if (!isThemeName(theme)) throw new Error('Unknown theme.')
  await updateSettings((settings) => {
    settings.theme = theme
  })
  // The page already applied the class and the cookie. A refresh here would reload Settings
  // under the click that chose the theme.
}

export async function setDefaultProviderAction(id: unknown) {
  if (!PROVIDERS.some((provider) => provider.id === id)) throw new Error('Unknown provider.')
  await setDefaultProvider(id as ProviderId)
  refresh()
}

export type AddConnectorResult = { error?: string; added?: boolean }

export async function addConnectorAction(_previous: AddConnectorResult, form: FormData): Promise<AddConnectorResult> {
  const provider = form.get('provider')
  const name = form.get('name')
  if (provider !== 'claude' && provider !== 'codex') return { error: 'Unknown harness.' }
  if (typeof name !== 'string') return { error: 'Unknown connector.' }
  try {
    await addConnector(provider, name)
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'The connector could not be added.' }
  }
  refresh()
  return { added: true }
}

export async function saveAlwaysAskAction(_previous: AlwaysAskResult, form: FormData): Promise<AlwaysAskResult> {
  const text = form.get('rules')
  const error = alwaysAskError(text)
  if (error) {
    return { error }
  }
  await saveAlwaysAsk(text as string)
  return { saved: true }
}
