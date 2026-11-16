import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS_FILE } from '../config'
import { readTasksAt, subscribeToTasks, TASKS_FILE, type TaskRecord } from '../tasks'
import { readProjectGraph, RECORDS_FOLDER, type ProjectGraph } from './project-graph'

// Keeps one live project graph per data folder while a window is watching it.
// It rebuilds the graph when the task list, settings, a task's records, or an
// agent's status change, and sends it to listeners only when it differs.

// Changes arrive in bursts (an agent rewriting a file, git checking out); one
// rebuild per burst keeps reads cheap and still lands well inside 2 seconds.
const DEBOUNCE_MS = 100
// Watch events can be lost: on macOS libuv shares one FSEvents stream among
// all watchers and restarts it whenever a watch is added, dropping changes
// made during the restart (seen when several windows or tasks start watching
// at once). Re-reading this often bounds the delay to well under 2 seconds;
// the watchers still make most updates near-instant.
const RESCAN_MS = 1_000

type Listener = (graph: ProjectGraph) => void

type Hub = {
  folder: string
  listeners: Set<Listener>
  graph: ProjectGraph | null
  json: string
  watchers: Map<string, FSWatcher>
  timer: ReturnType<typeof setTimeout> | null
  rescan: ReturnType<typeof setInterval>
  refreshing: Promise<void> | null
  dirty: boolean
  /** Set once the last listener leaves; a rebuild still running must not add watchers after that. */
  closed: boolean
  stopTasks: () => void
}

// On globalThis so dev reloads of this module keep one hub (and one set of watchers) per folder.
const HUBS_KEY = Symbol.for('busyboy.record-hubs')
const globalStore = globalThis as typeof globalThis & { [HUBS_KEY]?: Map<string, Hub> }
const hubs = (globalStore[HUBS_KEY] ??= new Map())

function schedule(hub: Hub) {
  if (hub.closed) return
  if (hub.timer) clearTimeout(hub.timer)
  hub.timer = setTimeout(() => {
    hub.timer = null
    void refresh(hub)
  }, DEBOUNCE_MS)
}

function refresh(hub: Hub): Promise<void> {
  // One rebuild at a time; a change during a rebuild runs one more afterwards.
  if (hub.refreshing) {
    hub.dirty = true
    return hub.refreshing
  }
  hub.refreshing = (async () => {
    do {
      hub.dirty = false
      // Every await can outlast the hub, so check it is still open after each one.
      const tasks = await readTasksAt(hub.folder).catch(() => null)
      if (hub.closed) return
      rewatch(hub, tasks)
      const graph = await readProjectGraph(hub.folder)
      if (hub.closed) return
      const json = JSON.stringify(graph)
      if (json === hub.json) continue
      hub.graph = graph
      hub.json = json
      for (const listener of hub.listeners) {
        // One broken listener (a closed stream) must not keep the graph from the others.
        try {
          listener(graph)
        } catch (error) {
          console.error('[records] a project graph listener failed:', error)
        }
      }
    } while (hub.dirty)
  })().finally(() => {
    hub.refreshing = null
  })
  return hub.refreshing
}

function addWatcher(hub: Hub, path: string, recursive: boolean, accept: (name: string | null) => boolean) {
  if (hub.closed) return
  const key = `${recursive ? 'r' : 'd'}:${path}`
  if (hub.watchers.has(key)) return
  try {
    const watcher = watch(path, { recursive }, (_event, name) => {
      if (accept(typeof name === 'string' ? name : null)) schedule(hub)
    })
    // A folder that goes away (a removed worktree) ends its watcher; the next rebuild sets up what exists.
    watcher.on('error', () => {
      watcher.close()
      hub.watchers.delete(key)
      schedule(hub)
    })
    hub.watchers.set(key, watcher)
  } catch {
    // Not there yet: the parent folder's watcher reports when it appears.
  }
}

/**
 * Watches the data folder, each task worktree's top level, and each `.jwn`
 * folder recursively. Without a readable task list it keeps the watchers it has.
 */
function rewatch(hub: Hub, tasks: TaskRecord[] | null) {
  const wanted = new Set<string>()
  const want = (path: string, recursive: boolean, accept: (name: string | null) => boolean) => {
    wanted.add(`${recursive ? 'r' : 'd'}:${path}`)
    addWatcher(hub, path, recursive, accept)
  }
  want(hub.folder, false, (name) => name === null || name === TASKS_FILE || name === SETTINGS_FILE)
  if (!tasks) return
  for (const task of tasks) {
    // A hand-edited entry without a worktree has nothing to watch; the graph reports it.
    if (typeof task?.worktree !== 'string') continue
    // Only `.jwn` itself appearing or going away matters at the top of a worktree.
    want(task.worktree, false, (name) => name === null || name === RECORDS_FOLDER)
    want(join(task.worktree, RECORDS_FOLDER), true, () => true)
  }
  for (const [key, watcher] of hub.watchers) {
    if (!wanted.has(key)) {
      watcher.close()
      hub.watchers.delete(key)
    }
  }
}

function close(hub: Hub) {
  hub.closed = true
  if (hub.timer) clearTimeout(hub.timer)
  clearInterval(hub.rescan)
  for (const watcher of hub.watchers.values()) watcher.close()
  hub.watchers.clear()
  hub.stopTasks()
  hubs.delete(hub.folder)
}

/** Calls `listener` with the graph now and after every change, until the returned function is called. */
export async function subscribeToProjectGraph(folder: string, listener: Listener) {
  let hub = hubs.get(folder)
  if (!hub) {
    const created: Hub = {
      folder,
      listeners: new Set(),
      graph: null,
      json: '',
      watchers: new Map(),
      timer: null,
      rescan: setInterval(() => void refresh(created), RESCAN_MS),
      refreshing: null,
      dirty: false,
      closed: false,
      // Agent status changes (running, waiting, stopped) are not file changes.
      stopTasks: subscribeToTasks(folder, () => schedule(created)),
    }
    hubs.set(folder, (hub = created))
  }
  const current = hub
  let sent = false
  const deliver: Listener = (graph) => {
    sent = true
    listener(graph)
  }
  current.listeners.add(deliver)
  if (!current.graph) await refresh(current)
  // A rebuild that was already running may have found nothing new to send.
  if (!sent && current.graph) deliver(current.graph)
  return () => {
    // Only the first call counts, so a second one cannot close a newer hub for the same folder.
    if (!current.listeners.delete(deliver)) return
    if (current.listeners.size === 0 && !current.closed) close(current)
  }
}
