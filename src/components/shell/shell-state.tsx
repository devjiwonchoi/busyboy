'use client'

import { createContext, useCallback, useContext, useMemo, useState } from 'react'

type PanelState = {
  panelOpen: boolean
  setPanelOpen: (open: boolean) => void
  togglePanel: () => void
}

const PanelStateContext = createContext<PanelState | null>(null)

/**
 * The task the user picked in the chat; the terminal opens in its worktree.
 * It is a snapshot: tasks are never renamed or removed today, and if one were, the
 * server answers a terminal for it with "That task no longer exists."
 */
export type SelectedTask = { id: string; project: string; title: string }

type TaskSelection = {
  selectedTask: SelectedTask | null
  /** Selects `task`, or clears the selection when `task` is already the selected one. */
  toggleTask: (task: SelectedTask) => void
}

const TaskSelectionContext = createContext<TaskSelection | null>(null)

/** Owns the bottom panel state and which task the terminal opens in. */
export function ShellStateProvider({ children }: { children: React.ReactNode }) {
  const [panelOpen, setPanelOpen] = useState(false)
  const togglePanel = useCallback(() => setPanelOpen((open) => !open), [])
  const panel = useMemo(() => ({ panelOpen, setPanelOpen, togglePanel }), [panelOpen, togglePanel])
  const [selectedTask, setSelectedTask] = useState<SelectedTask | null>(null)
  const toggleTask = useCallback(
    (task: SelectedTask) => setSelectedTask((selected) => (selected?.id === task.id ? null : task)),
    [],
  )
  const selection = useMemo(() => ({ selectedTask, toggleTask }), [selectedTask, toggleTask])
  return (
    <PanelStateContext value={panel}>
      <TaskSelectionContext value={selection}>{children}</TaskSelectionContext>
    </PanelStateContext>
  )
}

/** Open, close, or toggle the bottom panel from anywhere in the shell. */
export function useShellState() {
  const panel = useContext(PanelStateContext)
  if (!panel) throw new Error('useShellState must be used inside ShellStateProvider.')
  return panel
}

/** The selected task, shared by the chat's task lines and the terminal. */
export function useTaskSelection() {
  const selection = useContext(TaskSelectionContext)
  if (!selection) throw new Error('useTaskSelection must be used inside ShellStateProvider.')
  return selection
}
