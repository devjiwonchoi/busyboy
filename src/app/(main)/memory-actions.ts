'use server'

import { forgetFact, MemoryError, writeFact } from '@/server/memory'

// Server actions are public endpoints, so every argument is checked at runtime.
const MAX_TEXT = 20_000

function checkScope(project: unknown, id: unknown) {
  if (project !== null && typeof project !== 'string') throw new Error('The project must be a name or null.')
  if (typeof id !== 'string' || !id) throw new Error('The memory id is missing.')
  return { project, id }
}

/** Errors the user can fix come back as a message; anything else throws. */
async function userError(work: () => Promise<unknown>) {
  try {
    await work()
    return null
  } catch (error) {
    if (error instanceof MemoryError) return error.message
    throw error
  }
}

export async function saveMemoryAction(project: string | null, id: string, title: string, text: string) {
  const scope = checkScope(project, id)
  if (typeof title !== 'string' || typeof text !== 'string' || title.length > 200 || text.length > MAX_TEXT) {
    throw new Error('A memory is a title of at most 200 characters and text of at most 20,000.')
  }
  return userError(() => writeFact({ ...scope, title, text }))
}

export async function forgetMemoryAction(project: string | null, id: string) {
  const scope = checkScope(project, id)
  return userError(() => forgetFact(scope))
}
