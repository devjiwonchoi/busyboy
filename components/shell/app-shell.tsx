'use client'

import { PanelBottom, PanelRight } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShellStateProvider, useShellState } from './shell-state'
import { formatShortcut, ShortcutRegistryProvider, useShortcut, type Shortcut } from './shortcut-registry'

type AppShellProps = {
  children: React.ReactNode
  sidebar: React.ReactNode
  panel: React.ReactNode
}

export function AppShell(props: AppShellProps) {
  return (
    <ShortcutRegistryProvider>
      <ShellStateProvider>
        <ShellLayout {...props} />
      </ShellStateProvider>
    </ShortcutRegistryProvider>
  )
}

const toggleSidebarKeys = { key: 'b', mod: true } as const
const togglePanelKeys = { key: 'j', mod: true } as const

function ShellLayout({ children, sidebar, panel }: AppShellProps) {
  const { sidebarOpen, panelOpen, toggleSidebar, togglePanel } = useShellState()

  useShortcut({ id: 'toggle-sidebar', label: 'Toggle sidebar', ...toggleSidebarKeys, run: toggleSidebar })
  useShortcut({ id: 'toggle-panel', label: 'Toggle bottom panel', ...togglePanelKeys, run: togglePanel })

  return (
    <div data-slot="app-shell" className="flex h-dvh flex-col overflow-hidden">
      <header
        data-slot="title-bar"
        className="flex h-10 shrink-0 items-center gap-1 border-b pr-2 pl-[var(--title-bar-inset,0.75rem)] [app-region:drag]"
      >
        <span className="text-sm font-medium">Busyboy</span>
        <div className="ml-auto flex items-center gap-1 [app-region:no-drag]">
          <ToggleButton
            label="Toggle bottom panel"
            shortcut={togglePanelKeys}
            pressed={panelOpen}
            onClick={togglePanel}
            icon={<PanelBottom />}
          />
          <ToggleButton
            label="Toggle sidebar"
            shortcut={toggleSidebarKeys}
            pressed={sidebarOpen}
            onClick={toggleSidebar}
            icon={<PanelRight />}
          />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <main data-slot="chat-area" aria-label="Chat" className="min-h-0 flex-1 overflow-auto">
            {children}
          </main>
          <section
            data-slot="bottom-panel"
            aria-label="Bottom panel"
            hidden={!panelOpen}
            className="h-72 shrink-0 border-t"
          >
            {panel}
          </section>
        </div>
        <aside
          data-slot="right-sidebar"
          aria-label="Sidebar"
          hidden={!sidebarOpen}
          className="bg-sidebar text-sidebar-foreground w-80 shrink-0 border-l border-sidebar-border"
        >
          {sidebar}
        </aside>
      </div>
    </div>
  )
}

function subscribeNothing() {
  return () => {}
}

function useIsMac() {
  return useSyncExternalStore(
    subscribeNothing,
    () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent),
    () => true,
  )
}

function ToggleButton({
  label,
  shortcut,
  pressed,
  onClick,
  icon,
}: {
  label: string
  shortcut: Pick<Shortcut, 'key' | 'mod'>
  pressed: boolean
  onClick: () => void
  icon: React.ReactNode
}) {
  const mac = useIsMac()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} aria-pressed={pressed} onClick={onClick}>
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} <kbd className="ml-1 font-sans opacity-70">{formatShortcut(shortcut, mac)}</kbd>
      </TooltipContent>
    </Tooltip>
  )
}
