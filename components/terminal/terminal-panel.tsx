'use client'

import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { SquareTerminal, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useShellState } from '@/components/shell/shell-state'
import { Button } from '@/components/ui/button'
import { createInputSender, followTerminal, killTerminal, resizeTerminal, startTerminal } from './terminal-session'
import { prefersDark, readTerminalTheme } from './terminal-theme'

const FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'

/** Keys the app shell owns; the terminal lets them through instead of sending them to the shell. */
function isAppShortcut(event: KeyboardEvent) {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
  const mod = mac ? event.metaKey : event.ctrlKey
  return mod && !event.altKey && ['b', 'j'].includes(event.key.toLowerCase())
}

/**
 * The bottom panel's terminal. A shell starts the first time the panel opens
 * and lives on while the panel is hidden; closing the terminal or exiting the
 * shell ends it, and the next open starts a fresh one.
 */
export function TerminalPanel() {
  const { panelOpen, setPanelOpen } = useShellState()
  const [generation, setGeneration] = useState(0)
  const [started, setStarted] = useState(false)
  const [cwd, setCwd] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (panelOpen && !started) setStarted(true)

  const end = () => {
    setStarted(false)
    setCwd(null)
    setGeneration((value) => value + 1)
    setPanelOpen(false)
  }

  return (
    <div data-slot="terminal-panel" className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-medium">Terminal</span>
        <span
          data-slot="terminal-cwd"
          aria-label="Working directory"
          title={cwd ?? undefined}
          className="min-w-0 truncate font-mono text-muted-foreground"
        >
          {cwd}
        </span>
        <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="Close terminal" onClick={end}>
          <X />
        </Button>
      </div>
      {error ? (
        <p role="alert" className="p-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {started ? (
        <TerminalView
          key={generation}
          active={panelOpen}
          onStart={(value) => {
            setError(null)
            setCwd(value)
          }}
          onError={setError}
          onExit={end}
        />
      ) : null}
    </div>
  )
}

function TerminalView({
  active,
  onStart,
  onError,
  onExit,
}: {
  active: boolean
  onStart: (cwd: string) => void
  onError: (message: string) => void
  onExit: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<{ term: Terminal; fit: () => void } | null>(null)
  const callbacks = useRef({ onStart, onError, onExit })
  useEffect(() => {
    callbacks.current = { onStart, onError, onExit }
  })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const abort = new AbortController()
    let id: string | null = null

    const term = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: readTerminalTheme(host),
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.attachCustomKeyEventHandler((event) => !isAppShortcut(event))
    term.open(host)

    let lastSize = ''
    const fit = () => {
      // A hidden panel has no size; fitting it would shrink the shell to nothing.
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      fitAddon.fit()
      const size = `${term.cols}x${term.rows}`
      if (size === lastSize) return
      lastSize = size
      if (id) resizeTerminal(id, term.cols, term.rows)
    }
    terminalRef.current = { term, fit }
    fit()

    const observer = new ResizeObserver(() => fit())
    observer.observe(host)

    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    const onSchemeChange = () => {
      // The tokens switch with the media query; read them after styles update.
      requestAnimationFrame(() => {
        term.options.theme = readTerminalTheme(host)
        host.dataset.colorScheme = prefersDark() ? 'dark' : 'light'
      })
    }
    host.dataset.colorScheme = prefersDark() ? 'dark' : 'light'
    scheme.addEventListener('change', onSchemeChange)

    void (async () => {
      try {
        const started = await startTerminal({ cols: term.cols, rows: term.rows }, abort.signal)
        id = started.id
        if (abort.signal.aborted) {
          killTerminal(started.id)
          return
        }
        callbacks.current.onStart(started.cwd)
        const send = createInputSender(started.id)
        term.onData(send)
        // The panel may have been resized while the shell started.
        resizeTerminal(started.id, term.cols, term.rows)
        await followTerminal(started.id, abort.signal, (event) => {
          if (event.type === 'data') term.write(event.data)
          else callbacks.current.onExit()
        })
      } catch (error) {
        if (abort.signal.aborted) return
        callbacks.current.onError(error instanceof Error ? error.message : String(error))
      }
    })()

    return () => {
      abort.abort()
      if (id) killTerminal(id)
      observer.disconnect()
      scheme.removeEventListener('change', onSchemeChange)
      terminalRef.current = null
      term.dispose()
    }
  }, [])

  useEffect(() => {
    if (!active) return
    const current = terminalRef.current
    if (!current) return
    current.fit()
    current.term.focus()
  }, [active])

  return (
    <div
      ref={hostRef}
      data-slot="terminal"
      role="region"
      aria-label="Terminal"
      className="min-h-0 flex-1 bg-background py-1 pl-3 [&_.xterm]:h-full [&_.xterm-viewport]:bg-transparent!"
    />
  )
}
