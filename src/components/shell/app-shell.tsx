'use client'

import { PanelBottom, PanelRight, Settings } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { usePanelRef } from 'react-resizable-panels'
import { buttonVariants } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Sidebar, SidebarContent, SidebarInset, SidebarRail } from '@/components/ui/sidebar'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { FocusHandler } from './focus-handler'
import { ShellStateProvider, useShellState } from './shell-state'
import {
  formatShortcut,
  isMacPlatform,
  ShortcutRegistryProvider,
  useShortcut,
  type Shortcut,
} from './shortcut-registry'

type AppShellProps = {
  children: React.ReactNode
  sidebar: React.ReactNode
  panel: React.ReactNode
}

export function AppShell(props: AppShellProps) {
  return (
    <ShortcutRegistryProvider>
      <ShellStateProvider>
        <TooltipProvider>
          <ShellLayout {...props} />
        </TooltipProvider>
      </ShellStateProvider>
    </ShortcutRegistryProvider>
  )
}

const toggleSidebarKeys = { key: 'b', mod: true } as const
const togglePanelKeys = { key: 'j', mod: true } as const

// The sidebar holds the project graph, which needs room to read; 20rem (shell-state.tsx) is the default.
const SIDEBAR_RESIZE = { minWidth: 256, maxWidth: 720, storageKey: 'busyboy:sidebar-width' }

const PANEL_DEFAULT_SIZE = 288
const PANEL_MIN_SIZE = 120

/**
 * Keeps the collapsible bottom panel in step with the shell state: the toggle
 * and shortcut expand or collapse it, and dragging it shut closes it.
 */
function useBottomPanel(panelOpen: boolean, setPanelOpen: (open: boolean) => void) {
  const panelRef = usePanelRef()
  const lastSize = useRef(PANEL_DEFAULT_SIZE)
  useEffect(() => {
    const handle = panelRef.current
    if (!handle) return
    if (panelOpen && handle.isCollapsed()) handle.resize(lastSize.current)
    if (!panelOpen && !handle.isCollapsed()) handle.collapse()
  }, [panelOpen, panelRef])
  const onResize = (size: { inPixels: number }) => {
    if (size.inPixels >= PANEL_MIN_SIZE) lastSize.current = size.inPixels
    const open = size.inPixels > 0
    if (open !== panelOpen) setPanelOpen(open)
  }
  return { panelRef, onResize }
}

// The title bar is a layout region rather than a control, so it stays a plain
// element around library parts.
function ShellLayout({ children, sidebar, panel }: AppShellProps) {
  const { sidebarOpen, panelOpen, setPanelOpen, toggleSidebar, togglePanel } = useShellState()
  const bottomPanel = useBottomPanel(panelOpen, setPanelOpen)

  useShortcut({ id: 'toggle-sidebar', label: 'Toggle sidebar', ...toggleSidebarKeys, run: toggleSidebar })
  useShortcut({ id: 'toggle-panel', label: 'Toggle bottom panel', ...togglePanelKeys, run: togglePanel })

  return (
    <div data-slot="app-shell" className="flex min-h-0 flex-1 flex-col">
      <FocusHandler />
      <header
        data-slot="title-bar"
        className="flex h-10 shrink-0 items-center gap-1 border-b pr-2 pl-[var(--title-bar-inset,0.75rem)] [app-region:drag]"
      >
        <span className="text-sm font-medium">BusyBoy</span>
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
          <Tooltip>
            <TooltipTrigger
              // A link styled as a button: Base UI's Button would give it role="button".
              render={<Link href="/setup" aria-label="Setup" className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })} />}
            >
              <Settings />
            </TooltipTrigger>
            <TooltipContent>Setup</TooltipContent>
          </Tooltip>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <SidebarInset className="min-h-0 min-w-0">
          <ResizablePanelGroup orientation="vertical">
            <ResizablePanel id="chat" minSize={160}>
              <div data-slot="chat-area" role="region" aria-label="Chat" className="h-full overflow-auto">
                {children}
              </div>
            </ResizablePanel>
            <ResizableHandle className={panelOpen ? undefined : 'hidden'} />
            <ResizablePanel
              id="bottom-panel"
              panelRef={bottomPanel.panelRef}
              collapsible
              collapsedSize="0"
              defaultSize="0"
              minSize={PANEL_MIN_SIZE}
              onResize={bottomPanel.onResize}
            >
              <section data-slot="bottom-panel" aria-label="Bottom panel" hidden={!panelOpen} className="h-full">
                {panel}
              </section>
            </ResizablePanel>
          </ResizablePanelGroup>
        </SidebarInset>
        {/* inert: the closed sidebar slides off-canvas but must not keep focus or screen reader access. */}
        <Sidebar
          side="right"
          role="complementary"
          aria-label="Sidebar"
          inert={!sidebarOpen}
          className="top-10 h-[calc(100svh-2.5rem)]"
        >
          <SidebarContent>{sidebar}</SidebarContent>
          <SidebarRail resize={SIDEBAR_RESIZE} />
        </Sidebar>
      </div>
    </div>
  )
}

function subscribeNothing() {
  return () => {}
}

function useIsMac() {
  return useSyncExternalStore(subscribeNothing, isMacPlatform, () => true)
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
      <TooltipTrigger render={<Toggle size="sm" aria-label={label} pressed={pressed} onPressedChange={onClick} />}>
        {icon}
      </TooltipTrigger>
      <TooltipContent>
        {label} <Kbd>{formatShortcut(shortcut, mac)}</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}
