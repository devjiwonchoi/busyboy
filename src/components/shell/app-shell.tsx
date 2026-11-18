"use client";

import { PanelBottom, Settings } from "lucide-react";
import Link from "next/link";
import { useRef, useSyncExternalStore } from "react";
import { usePanelRef } from "react-resizable-panels";

import { buttonVariants } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useExternalSync } from "@/hooks/use-external-sync";

import { FocusHandler } from "./focus-handler";
import { ShellStateProvider, useShellState } from "./shell-state";
import {
  formatShortcut,
  isMacPlatform,
  ShortcutRegistryProvider,
  TOGGLE_PANEL_KEYS,
  useShortcut,
  type Shortcut,
} from "./shortcut-registry";
import { UpdateButton } from "./update-button";

type AppShellProps = {
  children: React.ReactNode;
  panel: React.ReactNode;
};

export function AppShell(props: AppShellProps) {
  return (
    <ShortcutRegistryProvider>
      <ShellStateProvider>
        <TooltipProvider>
          <ShellLayout {...props} />
        </TooltipProvider>
      </ShellStateProvider>
    </ShortcutRegistryProvider>
  );
}

const PANEL_DEFAULT_SIZE = 288;
const PANEL_MIN_SIZE = 120;

function useBottomPanel(panelOpen: boolean, setPanelOpen: (open: boolean) => void) {
  const panelRef = usePanelRef();
  const lastSize = useRef(PANEL_DEFAULT_SIZE);
  useExternalSync(() => {
    const handle = panelRef.current;
    if (!handle) return;
    if (panelOpen && handle.isCollapsed()) handle.resize(lastSize.current);
    if (!panelOpen && !handle.isCollapsed()) handle.collapse();
  }, [panelOpen, panelRef]);
  const onResize = (size: { inPixels: number }) => {
    if (size.inPixels >= PANEL_MIN_SIZE) lastSize.current = size.inPixels;
    const open = size.inPixels > 0;
    if (open !== panelOpen) setPanelOpen(open);
  };
  return { panelRef, onResize };
}

function ShellLayout({ children, panel }: AppShellProps) {
  const { panelOpen, setPanelOpen, togglePanel } = useShellState();
  const bottomPanel = useBottomPanel(panelOpen, setPanelOpen);

  useShortcut({
    id: "toggle-panel",
    label: "Toggle bottom panel",
    ...TOGGLE_PANEL_KEYS,
    run: togglePanel,
  });

  return (
    <div data-slot="app-shell" className="flex h-dvh min-h-0 w-full flex-col overflow-hidden">
      <FocusHandler />
      <header
        data-slot="title-bar"
        className="flex h-10 shrink-0 items-center gap-1 border-b pr-2 pl-[var(--title-bar-inset,0.75rem)] [app-region:drag]"
      >
        <span className="text-sm font-medium">BusyBoy</span>
        <div className="ml-auto flex items-center gap-1 [app-region:no-drag]">
          <UpdateButton />
          <ToggleButton
            label="Toggle bottom panel"
            shortcut={TOGGLE_PANEL_KEYS}
            pressed={panelOpen}
            onClick={togglePanel}
            icon={<PanelBottom />}
          />
          <Tooltip>
            <TooltipTrigger
              // why: A link styled as a button: Base UI's Button would give it role="button".
              render={
                <Link
                  href="/settings"
                  aria-label="Settings"
                  className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
                />
              }
            >
              <Settings />
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <main className="min-h-0 min-w-0 flex-1">
          <ResizablePanelGroup orientation="vertical">
            <ResizablePanel id="chat" minSize={160}>
              <div
                data-slot="chat-area"
                role="region"
                aria-label="Chat"
                className="h-full overflow-auto"
              >
                {children}
              </div>
            </ResizablePanel>
            <ResizableHandle className={panelOpen ? undefined : "hidden"} />
            <ResizablePanel
              id="bottom-panel"
              panelRef={bottomPanel.panelRef}
              collapsible
              collapsedSize="0"
              defaultSize="0"
              minSize={PANEL_MIN_SIZE}
              onResize={bottomPanel.onResize}
            >
              <section
                data-slot="bottom-panel"
                aria-label="Bottom panel"
                hidden={!panelOpen}
                className="h-full"
              >
                {panel}
              </section>
            </ResizablePanel>
          </ResizablePanelGroup>
        </main>
      </div>
    </div>
  );
}

function subscribeNothing() {
  return () => {};
}

function useIsMac() {
  return useSyncExternalStore(subscribeNothing, isMacPlatform, () => true);
}

function ToggleButton({
  label,
  shortcut,
  pressed,
  onClick,
  icon,
}: {
  label: string;
  shortcut: Pick<Shortcut, "key" | "mod">;
  pressed: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  const mac = useIsMac();
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Toggle size="sm" aria-label={label} pressed={pressed} onPressedChange={onClick} />}
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent>
        {label} <Kbd>{formatShortcut(shortcut, mac)}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
