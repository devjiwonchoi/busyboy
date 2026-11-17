"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import "@xterm/xterm/css/xterm.css";
import { FolderOpen, Plus, RotateCcw, SquareTerminal, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useShellState, useTaskSelection } from "@/components/shell/shell-state";
import {
  COMMAND_PALETTE_KEYS,
  isMacPlatform,
  matchesShortcut,
  NEW_TASK_KEYS,
  TOGGLE_PANEL_KEYS,
  useShortcut,
} from "@/components/shell/shortcut-registry";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { desktopBridge } from "@/lib/desktop-bridge";

import {
  createInputSender,
  followTerminal,
  killTerminal,
  resizeTerminal,
  startTerminal,
  type StartedTerminal,
} from "./terminal-session";
import { readTerminalTheme } from "./terminal-theme";

const FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

const toggleFromTerminalKeys = { key: "`", mod: true } as const;

function subscribeNothing() {
  return () => {};
}

// Off macOS, Ctrl+J is the shell's line feed, so the panel toggle from inside the terminal is Ctrl+`.
function isAppShortcut(event: KeyboardEvent) {
  const mac = isMacPlatform();
  if (matchesShortcut(COMMAND_PALETTE_KEYS, event, mac)) return true;
  if (matchesShortcut(NEW_TASK_KEYS, event, mac)) return true;
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod || event.shiftKey) return false;
  if (event.code === "Backquote" && !event.altKey) return true;
  return mac && matchesShortcut(TOGGLE_PANEL_KEYS, event, mac);
}

// Selecting another task must not replace a running shell: it may be mid-command or hold the user's history.
export function TerminalPanel() {
  const { panelOpen, setPanelOpen, togglePanel } = useShellState();
  useShortcut({
    id: "toggle-panel-from-terminal",
    label: "Toggle bottom panel",
    ...toggleFromTerminalKeys,
    run: togglePanel,
  });
  const [generation, setGeneration] = useState(0);
  const [started, setStarted] = useState(false);
  const [shell, setShell] = useState<Pick<StartedTerminal, "cwd" | "task"> | null>(null);
  const { selectedTask } = useTaskSelection();
  const bridge = useSyncExternalStore(subscribeNothing, desktopBridge, () => undefined);
  const selectionDiffers =
    shell !== null && (selectedTask?.id ?? null) !== (shell.task?.id ?? null);
  const [ended, setEnded] = useState<string | null>(null);

  if (panelOpen && !started) setStarted(true);

  const restart = () => {
    setEnded(null);
    setShell(null);
    setGeneration((value) => value + 1);
  };

  const close = () => {
    restart();
    setStarted(false);
    setPanelOpen(false);
  };

  return (
    <div data-slot="terminal-panel" className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-medium">Terminal</span>
        {shell?.task ? (
          <span data-slot="terminal-task" aria-label="Task" className="max-w-64 shrink-0 truncate">
            <span className="text-muted-foreground">{shell.task.project} · </span>
            {shell.task.title}
          </span>
        ) : null}
        <span
          data-slot="terminal-cwd"
          aria-label="Working directory"
          title={shell?.cwd}
          className="min-w-0 truncate font-mono text-muted-foreground"
        >
          {shell?.cwd}
        </span>
        {selectionDiffers && !ended ? (
          <Button
            variant="outline"
            size="xs"
            className="ml-auto shrink-0"
            title={
              selectedTask
                ? `Start a shell in ${selectedTask.project} · ${selectedTask.title}`
                : "Start a shell in the home folder"
            }
            onClick={restart}
          >
            <Plus />
            New terminal
          </Button>
        ) : null}
        {shell?.task && shell.cwd && bridge?.openInEditor && bridge.revealInFolder ? (
          <div
            className={
              selectionDiffers && !ended
                ? "flex shrink-0 items-center gap-1"
                : "ml-auto flex shrink-0 items-center gap-1"
            }
          >
            <Button variant="outline" size="xs" onClick={() => void bridge.openInEditor(shell.cwd)}>
              Open in editor
            </Button>
            <Button variant="ghost" size="xs" onClick={() => void bridge.revealInFolder(shell.cwd)}>
              <FolderOpen />
              Reveal in folder
            </Button>
          </div>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          className={
            (selectionDiffers && !ended) || (shell?.task && bridge?.openInEditor)
              ? "shrink-0"
              : "ml-auto shrink-0"
          }
          aria-label="Close terminal"
          onClick={close}
        >
          <X />
        </Button>
      </div>
      {ended ? (
        // A shell that ended is news, not an emergency, so this alert is a polite status.
        <Alert role="status" className="shrink-0 rounded-none border-x-0 border-t-0 px-3">
          <AlertDescription>{ended}</AlertDescription>
          <AlertAction className="top-1 right-3">
            <Button variant="outline" size="xs" onClick={restart}>
              <RotateCcw />
              New terminal
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {started ? (
        <TerminalView
          key={generation}
          active={panelOpen}
          taskId={selectedTask?.id ?? null}
          onStart={setShell}
          onEnd={setEnded}
        />
      ) : null}
    </div>
  );
}

function TerminalView({
  active,
  taskId,
  onStart,
  onEnd,
}: {
  active: boolean;
  taskId: string | null;
  onStart: (shell: Pick<StartedTerminal, "cwd" | "task">) => void;
  onEnd: (message: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<{ term: Terminal; fit: () => void } | null>(null);
  // Frozen at mount: a selection change must not re-run the effect below, which would kill the shell.
  const [startTaskId] = useState(taskId);
  const callbacks = useRef({ onStart, onEnd });
  useEffect(() => {
    callbacks.current = { onStart, onEnd };
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const abort = new AbortController();
    let id: string | null = null;

    const term = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: readTerminalTheme(host),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.attachCustomKeyEventHandler((event) => !isAppShortcut(event));
    term.open(host);

    let lastSize = "";
    const fit = () => {
      // A hidden panel has no size; fitting it would shrink the shell to nothing.
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      fitAddon.fit();
      const size = `${term.cols}x${term.rows}`;
      if (size === lastSize) return;
      lastSize = size;
      if (id) resizeTerminal(id, term.cols, term.rows);
    };
    terminalRef.current = { term, fit };
    fit();

    const observer = new ResizeObserver(() => fit());
    observer.observe(host);

    const onSchemeChange = () => {
      // The tokens follow the `dark` class; read them after styles update.
      requestAnimationFrame(() => {
        term.options.theme = readTerminalTheme(host);
      });
    };
    const scheme = new MutationObserver(onSchemeChange);
    scheme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    const end = (message: string) => {
      term.options.disableStdin = true;
      term.options.cursorBlink = false;
      callbacks.current.onEnd(message);
    };

    let send: ((data: string) => void) | null = null;
    let early = "";
    term.onData((data) => {
      if (send) send(data);
      else early += data;
    });

    void (async () => {
      try {
        const started = await startTerminal(
          { cols: term.cols, rows: term.rows, taskId: startTaskId },
          abort.signal,
        );
        id = started.id;
        if (abort.signal.aborted) {
          killTerminal(started.id);
          return;
        }
        callbacks.current.onStart({ cwd: started.cwd, task: started.task });
        send = createInputSender(started.id);
        if (early) send(early);
        early = "";
        resizeTerminal(started.id, term.cols, term.rows);
        let exited = false;
        await followTerminal(started.id, abort.signal, (event) => {
          if (event.type === "data") {
            term.write(event.data);
            return;
          }
          exited = true;
          end(
            event.killed
              ? "The shell was stopped."
              : `The shell exited with code ${event.exitCode}.`,
          );
        });
        if (!exited && !abort.signal.aborted) end("The connection to the shell closed.");
      } catch (error) {
        if (abort.signal.aborted) return;
        if (id) end("The connection to the shell closed.");
        else
          end(
            `The shell could not start: ${error instanceof Error ? error.message : String(error)}`,
          );
      }
    })();

    return () => {
      abort.abort();
      if (id) killTerminal(id);
      observer.disconnect();
      scheme.disconnect();
      terminalRef.current = null;
      term.dispose();
    };
  }, [startTaskId]);

  useEffect(() => {
    if (!active) return;
    const current = terminalRef.current;
    if (!current) return;
    current.fit();
    current.term.focus();
  }, [active]);

  // The fit addon measures the host's box including its padding, so the
  // padding lives on a wrapper and the host stays exactly the usable area.
  return (
    <div className="flex min-h-0 flex-1 bg-background py-1 pl-3">
      <div
        ref={hostRef}
        data-slot="terminal"
        role="region"
        aria-label="Terminal"
        className="min-h-0 min-w-0 flex-1 [&_.xterm]:h-full [&_.xterm-viewport]:bg-transparent!"
      />
    </div>
  );
}
