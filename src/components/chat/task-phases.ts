'use client'

import { useSyncExternalStore } from 'react'
import type { ProjectGraph } from '@/server/records/project-graph'
import type { TaskProgress } from '@/server/records/progress'
import type { TaskPhase } from '@/server/records/task-phase'

// The project graph is one stream for the whole window. Task rows read phases
// and the chat list reads progress, so a graph update does not re-render the
// composer or the terminal, and the window opens the stream once.

const empty = new Map<string, TaskPhase>()
const calm: TaskProgress = { total: 0, verified: 0, state: 'calm' }
const noProgress: ProgressSnapshot = { projects: [], total: calm }
let phases = empty
let progress: ProgressSnapshot = noProgress
const listeners = new Set<() => void>()
let source: EventSource | null = null
let subscribers = 0

export type ProjectProgress = { name: string; progress: TaskProgress }
type ProgressSnapshot = { projects: ProjectProgress[]; total: TaskProgress }

function sameProgress(a: TaskProgress, b: TaskProgress) {
  return a.total === b.total && a.verified === b.verified && a.state === b.state
}

function publish(nextPhases: Map<string, TaskPhase>, nextProgress: ProgressSnapshot) {
  const phasesSame = nextPhases.size === phases.size && [...nextPhases].every(([id, phase]) => phases.get(id) === phase)
  const progressSame =
    sameProgress(nextProgress.total, progress.total) &&
    nextProgress.projects.length === progress.projects.length &&
    nextProgress.projects.every(
      (project, index) => project.name === progress.projects[index].name && sameProgress(project.progress, progress.projects[index].progress),
    )
  if (phasesSame && progressSame) return
  if (!phasesSame) phases = nextPhases
  if (!progressSame) progress = nextProgress
  for (const listener of listeners) listener()
}

function ensureSource() {
  if (source || typeof EventSource === 'undefined') return
  source = new EventSource('/api/records/events')
  source.onmessage = (message) => {
    const graph = JSON.parse(message.data) as ProjectGraph
    if (graph.error) return
    const nextPhases = new Map<string, TaskPhase>()
    for (const project of graph.projects) {
      for (const task of project.tasks) {
        if (task.errors.length === 0) nextPhases.set(task.id, task.phase)
      }
    }
    publish(nextPhases, {
      projects: graph.projects.map((project) => ({ name: project.name, progress: project.progress })),
      total: graph.progress,
    })
  }
}

function subscribe(listener: () => void) {
  subscribers += 1
  ensureSource()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    subscribers -= 1
    if (subscribers === 0 && source) {
      source.close()
      source = null
    }
  }
}

/** The phase of every task in the project graph. */
export function useTaskPhases() {
  return useSyncExternalStore(subscribe, () => phases, () => empty)
}

/** Each project's aligned progress, and the sum across projects. */
export function useProjectProgress() {
  return useSyncExternalStore(subscribe, () => progress, () => noProgress)
}
