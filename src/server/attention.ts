import { subscribeToDirector } from './director/chat'
import type { GraphTask, NodeStatus, ProjectGraph } from './records/project-graph'
import { subscribeToProjectGraph } from './records/record-watcher'

// What needs the user right now, and the moments worth telling them about,
// for the desktop app's tray and notifications. Built from what the window
// already shows: the project graph's task status (an approval, a question, or
// a plan waiting for approval all show as `needs-you`) and the Director chat.
// Only ids, project names, and task titles leave here, never replies or tool
// output. Task titles are written by the Director, so they are the one agent
// text a notification can show.

export type AttentionTask = { taskId: string; project: string; title: string }

export type AttentionEvent =
  | ({ kind: 'task-needs-you' } & AttentionTask)
  | ({ kind: 'task-done' } & AttentionTask)
  | { kind: 'director-replied' }

export type AttentionUpdate =
  /** Every task that needs the user now; sent first and whenever the list changes. */
  | { type: 'state'; tasks: AttentionTask[] }
  | { type: 'event'; event: AttentionEvent }

const taskKey = (task: Pick<GraphTask, 'project' | 'id'>) => `${task.project}/${task.id}`

const toAttention = (task: GraphTask): AttentionTask => ({ taskId: task.id, project: task.project, title: task.title })

/** A task with unreadable records shows as an error node, not as its parsed status. */
const statusOf = (task: GraphTask): NodeStatus | 'error' => (task.errors.length > 0 ? 'error' : task.status)

/**
 * Calls `listener` with the current state, then with every change and event,
 * until the returned function is called. Events describe changes after the
 * first graph, so connecting never replays old news as new.
 */
export async function subscribeToAttention(folder: string, listener: (update: AttentionUpdate) => void) {
  let previous: Map<string, NodeStatus | 'error'> | null = null
  let lastState = ''
  let closed = false
  const seenReplies = new Set<string>()
  const send = (update: AttentionUpdate) => {
    if (!closed) listener(update)
  }

  const onGraph = (graph: ProjectGraph) => {
    // An unreadable task list says nothing about the tasks; keep the last known state.
    if (graph.error) return
    const tasks = graph.projects.flatMap((project) => project.tasks)
    // Agents rewrite records in place, so a read can catch a half-written file;
    // keep the last readable status, or done → error → done would announce twice.
    const current = new Map(
      tasks.map((task) => {
        const status = statusOf(task)
        return [taskKey(task), status === 'error' ? (previous?.get(taskKey(task)) ?? status) : status]
      }),
    )
    if (previous) {
      for (const task of tasks) {
        const before = previous.get(taskKey(task))
        const now = current.get(taskKey(task))
        if (before === now) continue
        // A task created already needing the user (rare) is news too; one created done is not.
        if (now === 'needs-you') send({ type: 'event', event: { kind: 'task-needs-you', ...toAttention(task) } })
        else if (now === 'done' && before !== undefined) send({ type: 'event', event: { kind: 'task-done', ...toAttention(task) } })
      }
    }
    previous = current
    const waiting = tasks.filter((task) => current.get(taskKey(task)) === 'needs-you').map(toAttention)
    const json = JSON.stringify(waiting)
    if (json === lastState) return
    lastState = json
    send({ type: 'state', tasks: waiting })
  }

  const stopGraph = await subscribeToProjectGraph(folder, onGraph)
  let stopDirector: () => void
  try {
    stopDirector = await subscribeToDirector(folder, (update) => {
      // A new reply, not a replaced one (an interrupted reply is the user's own doing).
      if (update.type === 'entry' && update.entry.kind === 'director' && !update.entry.interrupted && !seenReplies.has(update.entry.id)) {
        seenReplies.add(update.entry.id)
        send({ type: 'event', event: { kind: 'director-replied' } })
      }
    })
  } catch (error) {
    stopGraph()
    throw error
  }
  return () => {
    closed = true
    stopGraph()
    stopDirector()
  }
}
