'use server'

import { dataFolder } from '@/server/config'
import { adoptTasks, closeChat } from '@/server/director/chat'
import { createManager, ManagerError, removeManager } from '@/server/managers'
import { createRoom, RoomError } from '@/server/rooms'
import { releaseTasksOf } from '@/server/tasks'

export type CreateManagerResult = { error?: string; id?: string; kind?: 'manager' | 'room' }

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
  if (form.get('kind') === 'room') {
    const projects = form.getAll('projects').filter((entry): entry is string => typeof entry === 'string')
    try {
      const room = await createRoom({ name: value('name'), projects })
      return { id: room.id, kind: 'room' }
    } catch (error) {
      if (error instanceof RoomError) return { error: error.message }
      throw error
    }
  }
  try {
    const manager = await createManager({ name: value('name'), project: value('project'), folder: value('folder') })
    return { id: manager.id, kind: 'manager' }
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
  await adoptTasks(folder, await releaseTasksOf(folder, id))
}
