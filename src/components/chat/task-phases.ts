'use client'

import { useSyncExternalStore } from 'react'
import type { ProjectGraph } from '@/server/records/project-graph'
import type { TaskPhase } from '@/server/records/task-phase'

// The project graph is one stream for the whole window. Task rows read it
// here, so a graph update does not re-render the composer or the terminal.

const empty = new Map<string, TaskPhase>()
let phases = empty
const listeners = new Set<() => void>()
let source: EventSource | null = null
let subscribers = 0

function publish(next: Map<string, TaskPhase>) {
  if (next.size === phases.size && [...next].every(([id, phase]) => phases.get(id) === phase)) return
  phases = next
  for (const listener of listeners) listener()
}

function ensureSource() {
  if (source || typeof EventSource === 'undefined') return
  source = new EventSource('/api/records/events')
  source.onmessage = (message) => {
    const graph = JSON.parse(message.data) as ProjectGraph
    if (graph.error) return
    const next = new Map<string, TaskPhase>()
    for (const project of graph.projects) {
      for (const task of project.tasks) {
        if (task.errors.length === 0) next.set(task.id, task.phase)
      }
    }
    publish(next)
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
