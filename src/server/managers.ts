import { randomBytes } from 'node:crypto'
import { dataFolder, readSettingsAt, updateSettings, type ManagerEntry } from './config'
import { addProject, getProject, ProjectError } from './projects'

// A manager is a chat of its own that looks after one project: the user talks
// to it like the Director, and it creates tasks only in that project. Managers
// live in the settings file. A project has at most one manager, so a task's
// cards and results always have one chat to show in.
//
// The Director stays above them: it spans every project, and it shows whatever
// no manager owns.

export type Manager = ManagerEntry

export class ManagerError extends Error {}

const MAX_NAME_LENGTH = 40

// Kept on globalThis so `next dev` reloads keep the listeners and the removed ids.
const STORE_KEY = Symbol.for('busyboy.managers')
type Store = { listeners: Map<string, Set<() => void>>; removed: Set<string> }
const globalStore = globalThis as typeof globalThis & { [STORE_KEY]?: Store }
const store = (globalStore[STORE_KEY] ??= { listeners: new Map(), removed: new Set() })

/** The managers whose project still exists, oldest first. A manager of a removed project is hidden, not deleted. */
export async function listManagersAt(folder: string): Promise<Manager[]> {
  const { managers, projects } = await readSettingsAt(folder)
  const names = new Set(projects.map(({ name }) => name.toLowerCase()))
  return managers.filter(({ project }) => names.has(project.toLowerCase()))
}

export async function listManagers() {
  return listManagersAt(await dataFolder())
}

export async function getManagerAt(folder: string, id: string) {
  return (await listManagersAt(folder)).find((manager) => manager.id === id)
}

/**
 * Whether this manager was removed since the server started. A card that was
 * open at that moment still names it, and shows in the Director's chat instead.
 */
export function isRemovedManager(folder: string, id: string) {
  return store.removed.has(`${folder}\n${id}`)
}

/** Calls `listener` whenever a manager in `folder` is created or removed. */
export function subscribeToManagers(folder: string, listener: () => void) {
  let set = store.listeners.get(folder)
  if (!set) store.listeners.set(folder, (set = new Set()))
  set.add(listener)
  return () => set.delete(listener)
}

function notify(folder: string) {
  for (const listener of store.listeners.get(folder) ?? []) listener()
}

/**
 * Creates the manager of a project: one BusyBoy already knows (`project`), or a
 * git repository added now (`folder`). The name defaults to the project's.
 */
export async function createManager(input: { name?: string; project?: string; folder?: string }): Promise<Manager> {
  const name = input.name?.trim() ?? ''
  if (name.length > MAX_NAME_LENGTH) throw new ManagerError(`Use at most ${MAX_NAME_LENGTH} characters for the name.`)
  let project = input.project?.trim() ? await getProject(input.project.trim()) : undefined
  if (input.project?.trim() && !project) throw new ManagerError(`There is no project named ${input.project.trim()}.`)
  if (!project) {
    if (!input.folder?.trim()) throw new ManagerError('Choose a project, or enter the path of a git repository.')
    try {
      project = await addProject(input.folder)
    } catch (error) {
      if (error instanceof ProjectError) throw new ManagerError(error.message)
      throw error
    }
  }
  const projectName = project.name
  const manager = await updateSettings((settings) => {
    const existing = settings.managers.find((entry) => entry.project.toLowerCase() === projectName.toLowerCase())
    if (existing) throw new ManagerError(`${projectName} already has a manager, ${existing.name}.`)
    const entry: Manager = {
      id: randomBytes(6).toString('hex'),
      name: name || projectName,
      project: projectName,
      createdAt: new Date().toISOString(),
    }
    settings.managers.push(entry)
    return entry
  })
  notify(await dataFolder())
  return manager
}

/** Forgets the manager. Its project, its tasks, and its saved conversation stay. */
export async function removeManager(id: string) {
  const folder = await dataFolder()
  await updateSettings((settings) => {
    settings.managers = settings.managers.filter((manager) => manager.id !== id)
  })
  store.removed.add(`${folder}\n${id}`)
  notify(folder)
}
