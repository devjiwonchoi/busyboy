'use client'

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { SidebarProvider, useSidebar } from '@/components/ui/sidebar'

type PanelState = {
  panelOpen: boolean
  setPanelOpen: (open: boolean) => void
  togglePanel: () => void
}

const PanelStateContext = createContext<PanelState | null>(null)

/**
 * The task the user picked in the graph or the chat; the terminal opens in its worktree.
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

const sidebarStyle = { '--sidebar-width': '20rem' } as React.CSSProperties

/** Owns the right sidebar (shadcn SidebarProvider) and the bottom panel state. */
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
    <SidebarProvider style={sidebarStyle} className="h-dvh min-h-0 flex-col overflow-hidden">
      <PanelStateContext value={panel}>
        <TaskSelectionContext value={selection}>{children}</TaskSelectionContext>
      </PanelStateContext>
    </SidebarProvider>
  )
}

/** Open, close, or toggle the right sidebar and the bottom panel from anywhere in the shell. */
export function useShellState() {
  const panel = useContext(PanelStateContext)
  if (!panel) throw new Error('useShellState must be used inside ShellStateProvider.')
  const sidebar = useSidebar()
  return {
    ...panel,
    sidebarOpen: sidebar.isMobile ? sidebar.openMobile : sidebar.open,
    setSidebarOpen: sidebar.isMobile ? sidebar.setOpenMobile : sidebar.setOpen,
    toggleSidebar: sidebar.toggleSidebar,
  }
}

/** The selected task, shared by the graph, the chat's task lines, and the terminal. */
export function useTaskSelection() {
  const selection = useContext(TaskSelectionContext)
  if (!selection) throw new Error('useTaskSelection must be used inside ShellStateProvider.')
  return selection
}
