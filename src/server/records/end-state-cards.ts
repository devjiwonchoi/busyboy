import { pathKey } from '../paths'
import { presentCard, openCards, replaceOpenCard, settleCard } from '../task-cards'
import type { DoneCard, TaskCard } from '../cards/model'
import { readTasksAt } from '../tasks'
import type { TaskAchievement } from './end-state'

// Done cards for tasks whose records on main say they are done. The card is not
// the task agent's: an open done line must not make the task look like it is
// waiting, and stopping the agent must not dismiss the result.

type Shown = Map<string, { openedAt: string; json: string }>
const SHOWN_KEY = Symbol.for('busyboy.end-state-cards')
const globalStore = globalThis as typeof globalThis & { [SHOWN_KEY]?: Map<string, Shown> }
const shownByFolder = (globalStore[SHOWN_KEY] ??= new Map())

function shownFor(folder: string) {
  const key = pathKey(folder)
  let shown = shownByFolder.get(key)
  if (!shown) shownByFolder.set(key, (shown = new Map()))
  return shown
}

const isDone = (card: TaskCard): card is DoneCard => card.kind === 'done'

/** Opens, updates, or closes the done card of each task that has an agreed end state on main. */
export async function syncEndStateCards(folder: string, tasks: TaskAchievement[]) {
  const listed = await readTasksAt(folder).catch(() => [])
  const byId = new Map(listed.map((task) => [`${task.project}/${task.id}`, task]))
  const shown = shownFor(folder)
  const wanted = new Set<string>()
  for (const task of tasks) {
    if (!task.done || task.agreed === 0) continue
    const id = `done:${task.project}/${task.taskId}`
    const known = byId.get(`${task.project}/${task.taskId}`)
    const taskId = known?.id ?? task.taskId
    const achievement = { met: task.met, agreed: task.agreed }
    // A task agent may already be showing this task's done line. Put the share on that line
    // instead of opening a second one, and drop a line we opened for the same task.
    const live = openCards(folder).find((card) => isDone(card) && card.id !== id && card.project === task.project && card.taskId === taskId)
    if (live && isDone(live)) {
      replaceOpenCard({ folder, card: { ...live, achievement } })
      if (shown.delete(id)) {
        try {
          settleCard({ folder, cardId: id, outcome: 'Shown on the task line.' })
        } catch {
          // Closed already.
        }
      }
      continue
    }
    wanted.add(id)
    const title = known?.title || task.title
    const previous = shown.get(id)
    const card: TaskCard = {
      id,
      taskId,
      chat: known?.chat ?? null,
      project: task.project,
      taskTitle: title,
      openedAt: previous?.openedAt ?? task.at,
      kind: 'done',
      title,
      achievement,
      phase: 'done',
      pendingChecks: 0,
    }
    const json = JSON.stringify(card)
    if (previous?.json === json) continue
    shown.set(id, { openedAt: card.openedAt, json })
    presentCard({ folder, card, agentId: `end-state:${task.project}/${task.taskId}` })
  }
  for (const id of [...shown.keys()]) {
    if (wanted.has(id)) continue
    shown.delete(id)
    try {
      settleCard({ folder, cardId: id, outcome: 'The end state is no longer on main.' })
    } catch {
      // Closed already, between the read and this call.
    }
  }
}
