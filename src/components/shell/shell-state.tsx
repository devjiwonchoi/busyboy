'use client'

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { SidebarProvider, useSidebar } from '@/components/ui/sidebar'

type PanelState = {
  panelOpen: boolean
  setPanelOpen: (open: boolean) => void
  togglePanel: () => void
}

const PanelStateContext = createContext<PanelState | null>(null)

const sidebarStyle = { '--sidebar-width': '20rem' } as React.CSSProperties

/** Owns the right sidebar (shadcn SidebarProvider) and the bottom panel state. */
export function ShellStateProvider({ children }: { children: React.ReactNode }) {
  const [panelOpen, setPanelOpen] = useState(false)
  const togglePanel = useCallback(() => setPanelOpen((open) => !open), [])
  const panel = useMemo(() => ({ panelOpen, setPanelOpen, togglePanel }), [panelOpen, togglePanel])
  return (
    <SidebarProvider style={sidebarStyle} className="h-dvh min-h-0 flex-col overflow-hidden">
      <PanelStateContext value={panel}>{children}</PanelStateContext>
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
