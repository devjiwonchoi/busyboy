'use server'

import { refresh } from 'next/cache'
import { redirect } from 'next/navigation'
import { readSettings, updateSettings } from '@/server/config'
import { addProject, ProjectError, removeProject } from '@/server/projects'
import { providerState, PROVIDERS, setDefaultProvider, signedInProviders } from '@/server/providers'
import type { ProviderId } from '@/server/runner/contract'

export type AddProjectResult = { error?: string; added?: string }

export async function addProjectAction(_previous: AddProjectResult, form: FormData): Promise<AddProjectResult> {
  try {
    const project = await addProject(String(form.get('folder') ?? ''))
    refresh()
    return { added: project.name }
  } catch (error) {
    if (error instanceof ProjectError) return { error: error.message }
    throw error
  }
}

export async function removeProjectAction(name: string) {
  await removeProject(name)
  refresh()
}

export async function setDefaultProviderAction(provider: ProviderId) {
  // Server actions are public endpoints, so the argument is checked at runtime.
  if (!PROVIDERS.some(({ id }) => id === provider)) throw new Error('Unknown provider.')
  await setDefaultProvider(provider)
  refresh()
}

/** Checks sign-in again, skipping the short cache, after the user signed in from a terminal. */
export async function recheckProvidersAction() {
  await Promise.all([providerState('claude', { fresh: true }), providerState('codex', { fresh: true })])
  refresh()
}

export async function startChattingAction() {
  const [providers, settings] = await Promise.all([signedInProviders(), readSettings()])
  if (providers.length === 0 || settings.projects.length === 0) return
  await updateSettings((current) => {
    current.setupCompletedAt ??= new Date().toISOString()
  })
  redirect('/')
}
