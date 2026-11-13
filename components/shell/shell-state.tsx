'use client'

import { createContext, useCallback, useContext, useMemo, useState } from 'react'

type ShellState = {
  sidebarOpen: boolean
  panelOpen: boolean
  setSidebarOpen: (open: boolean) => void
  setPanelOpen: (open: boolean) => void
  toggleSidebar: () => void
  togglePanel: () => void
}

const ShellStateContext = createContext<ShellState | null>(null)

export function ShellStateProvider({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [panelOpen, setPanelOpen] = useState(false)
  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), [])
  const togglePanel = useCallback(() => setPanelOpen((open) => !open), [])
  const value = useMemo(
    () => ({ sidebarOpen, panelOpen, setSidebarOpen, setPanelOpen, toggleSidebar, togglePanel }),
    [sidebarOpen, panelOpen, toggleSidebar, togglePanel],
  )
  return <ShellStateContext value={value}>{children}</ShellStateContext>
}

/** Open, close, or toggle the right sidebar and the bottom panel from anywhere in the shell. */
export function useShellState() {
  const state = useContext(ShellStateContext)
  if (!state) throw new Error('useShellState must be used inside ShellStateProvider.')
  return state
}
