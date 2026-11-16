'use server'

import { dataFolder } from '@/server/config'
import { closeChat } from '@/server/director/chat'
import { createManager, ManagerError, removeManager } from '@/server/managers'
import { releaseTasksOf } from '@/server/tasks'

export type CreateManagerResult = { error?: string; id?: string }

/**
 * Creates a manager for a project BusyBoy knows (`project`) or for a git
 * repository added now (`folder`). A refusal the user can act on comes back as
 * `error`: a thrown error's message does not reach the window in a production build.
 */
export async function createManagerAction(_previous: CreateManagerResult, form: FormData): Promise<CreateManagerResult> {
  const value = (key: string) => {
    const entry = form.get(key)
    return typeof entry === 'string' ? entry : undefined
  }
  try {
    const manager = await createManager({ name: value('name'), project: value('project'), folder: value('folder') })
    return { id: manager.id }
  } catch (error) {
    if (error instanceof ManagerError) return { error: error.message }
    throw error
  }
}

/** Removes a manager: its agent ends and its tasks show in the Director's chat from now on. */
export async function removeManagerAction(id: string) {
  // Server actions are public endpoints, so the argument is checked at runtime.
  if (typeof id !== 'string' || !id || id.length > 100) throw new Error('The manager must be a non-empty id.')
  const folder = await dataFolder()
  await removeManager(id)
  await closeChat(folder, id)
  await releaseTasksOf(folder, id)
}
