'use client'

import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { RotateCcw, SquareTerminal, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useShellState } from '@/components/shell/shell-state'
import { Button } from '@/components/ui/button'
import { createInputSender, followTerminal, killTerminal, resizeTerminal, startTerminal } from './terminal-session'
import { prefersDark, readTerminalTheme } from './terminal-theme'

const FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'

/**
 * On macOS the app's Cmd+B and Cmd+J reach the app even from the terminal.
 * Elsewhere Ctrl+B and Ctrl+J belong to the shell (readline, tmux, line feed),
 * so they only work as app shortcuts outside the terminal.
 */
function isAppShortcut(event: KeyboardEvent) {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
  return mac && event.metaKey && !event.ctrlKey && !event.altKey && ['b', 'j'].includes(event.key.toLowerCase())
}

/**
 * The bottom panel's terminal. A shell starts the first time the panel opens
 * and lives on while the panel is hidden. Closing the terminal kills it and
 * the next open starts a fresh one. When the shell exits or cannot start, the
 * panel says so and offers a new terminal.
 */
export function TerminalPanel() {
  const { panelOpen, setPanelOpen } = useShellState()
  const [generation, setGeneration] = useState(0)
  const [started, setStarted] = useState(false)
  const [cwd, setCwd] = useState<string | null>(null)
  const [ended, setEnded] = useState<string | null>(null)

  if (panelOpen && !started) setStarted(true)

  const restart = () => {
    setEnded(null)
    setCwd(null)
    setGeneration((value) => value + 1)
  }

  const close = () => {
    restart()
    setStarted(false)
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
        <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="Close terminal" onClick={close}>
          <X />
        </Button>
      </div>
      {ended ? (
        <div role="status" className="flex shrink-0 items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
          <span>{ended}</span>
          <Button variant="outline" size="xs" onClick={restart}>
            <RotateCcw />
            New terminal
          </Button>
        </div>
      ) : null}
      {started ? (
        <TerminalView key={generation} active={panelOpen} onStart={setCwd} onEnd={setEnded} />
      ) : null}
    </div>
  )
}

function TerminalView({
  active,
  onStart,
  onEnd,
}: {
  active: boolean
  onStart: (cwd: string) => void
  /** Called once with a short line for the user when the shell is gone. */
  onEnd: (message: string) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<{ term: Terminal; fit: () => void } | null>(null)
  const callbacks = useRef({ onStart, onEnd })
  useEffect(() => {
    callbacks.current = { onStart, onEnd }
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

    const end = (message: string) => {
      term.options.disableStdin = true
      term.options.cursorBlink = false
      callbacks.current.onEnd(message)
    }

    // Keys typed while the shell starts are held and sent once it is up.
    let send: ((data: string) => void) | null = null
    let early = ''
    term.onData((data) => {
      if (send) send(data)
      else early += data
    })

    void (async () => {
      try {
        const started = await startTerminal({ cols: term.cols, rows: term.rows }, abort.signal)
        id = started.id
        if (abort.signal.aborted) {
          killTerminal(started.id)
          return
        }
        callbacks.current.onStart(started.cwd)
        send = createInputSender(started.id)
        if (early) send(early)
        early = ''
        // The panel may have been resized while the shell started.
        resizeTerminal(started.id, term.cols, term.rows)
        let exited = false
        await followTerminal(started.id, abort.signal, (event) => {
          if (event.type === 'data') {
            term.write(event.data)
            return
          }
          exited = true
          end(event.killed ? 'The shell was stopped.' : `The shell exited with code ${event.exitCode}.`)
        })
        if (!exited && !abort.signal.aborted) end('The connection to the shell closed.')
      } catch (error) {
        if (abort.signal.aborted) return
        if (id) end('The connection to the shell closed.')
        else end(`The shell could not start: ${error instanceof Error ? error.message : String(error)}`)
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
  )
}
