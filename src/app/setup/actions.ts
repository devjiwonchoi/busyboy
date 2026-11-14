'use server'

import { refresh } from 'next/cache'
import { redirect } from 'next/navigation'
import { resetAlwaysAsk, saveAlwaysAsk } from '@/server/always-ask-list'
import { readSettings, updateSettings } from '@/server/config'
import { chooseCompanion, CompanionImageError, findCompanion, removeCompanionImage, saveCompanionImage } from '@/server/companions'
import { addProject, ProjectError, removeProject } from '@/server/projects'
import { ruleError } from '@/server/runner/always-ask'
import { providerState, PROVIDERS, setDefaultProvider, signedInProviders } from '@/server/providers'
import type { ProviderId } from '@/server/runner/contract'
import { stepHref } from './steps'

// Server actions are public endpoints, so every argument is checked at runtime.

export type FormResult = { error?: string }

export async function chooseCompanionAction(_previous: FormResult, form: FormData): Promise<FormResult> {
  const id = form.get('companion')
  if (typeof id !== 'string' || !findCompanion(id)) return { error: 'Choose a companion to continue.' }
  await chooseCompanion(id)
  redirect(stepHref('agents'))
}

export async function setCompanionImageAction(_previous: FormResult, form: FormData): Promise<FormResult> {
  const file = form.get('image')
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose a picture first.' }
  try {
    await saveCompanionImage(file)
  } catch (error) {
    if (error instanceof CompanionImageError) return { error: error.message }
    throw error
  }
  refresh()
  return {}
}

export async function removeCompanionImageAction() {
  await removeCompanionImage()
  refresh()
}

export async function continueFromAgentsAction(form: FormData) {
  const provider = form.get('defaultProvider')
  // Only sent when two agents are signed in and the user can choose.
  if (typeof provider === 'string') {
    if (!PROVIDERS.some(({ id }) => id === provider)) throw new Error('Unknown provider.')
    await setDefaultProvider(provider as ProviderId)
  }
  redirect(stepHref('skills'))
}

/** Checks sign-in again, skipping the short cache, after the user signed in from a terminal. */
export async function recheckProvidersAction() {
  await Promise.all(PROVIDERS.map(({ id }) => providerState(id, { fresh: true })))
  refresh()
}

export type AddProjectsResult = { added: string[]; errors: string[] }

/** Adds folders from the picker, a drop, or a typed path. Each folder succeeds or fails on its own. */
export async function addProjectsAction(folders: unknown): Promise<AddProjectsResult> {
  if (!Array.isArray(folders) || folders.length > 100 || !folders.every((folder) => typeof folder === 'string')) {
    throw new Error('Folders must be a list of paths.')
  }
  const result: AddProjectsResult = { added: [], errors: [] }
  // One at a time, so default names stay unique and errors keep the user's order.
  for (const folder of folders) {
    try {
      result.added.push((await addProject(folder)).name)
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error
      result.errors.push(error.message)
    }
  }
  refresh()
  return result
}

export async function addTypedProjectAction(_previous: FormResult, form: FormData): Promise<FormResult> {
  const { errors } = await addProjectsAction([String(form.get('folder') ?? '')])
  return errors.length ? { error: errors[0] } : {}
}

export async function removeProjectAction(name: string) {
  if (typeof name !== 'string') throw new Error('The project name must be a string.')
  await removeProject(name)
  refresh()
}

/** Finishes setup, with or without projects. Sends the user back to a step that still needs them. */
export async function startChattingAction() {
  const [settings, signedIn] = await Promise.all([readSettings(), signedInProviders()])
  if (!findCompanion(settings.companion)) redirect(stepHref('companion'))
  if (signedIn.length === 0) redirect(stepHref('agents'))
  await updateSettings((current) => {
    current.setupCompletedAt ??= new Date().toISOString()
  })
  redirect('/')
}

const MAX_ALWAYS_ASK_LENGTH = 20_000

/** Saves the always-ask list from its text box, one rule per line, and goes on. A line that could never match is refused. */
export async function continueFromApprovalsAction(_previous: FormResult, form: FormData): Promise<FormResult> {
  const text = form.get('rules')
  if (typeof text !== 'string' || text.length > MAX_ALWAYS_ASK_LENGTH) {
    return { error: 'Keep the list under 20,000 characters.' }
  }
  const error = text.split('\n').map(ruleError).find(Boolean)
  if (error) {
    return { error }
  }
  await saveAlwaysAsk(text)
  redirect(stepHref('start'))
}

export async function restoreAlwaysAskAction() {
  await resetAlwaysAsk()
  refresh()
}
