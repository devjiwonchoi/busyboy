import type { TerminalEvent } from '@/server/terminal'

export type StartedTerminal = { id: string; cwd: string; shell: string }

const endpoint = (id: string) => `/api/terminal/${encodeURIComponent(id)}`

/** Starts a pty on the server. The `cwd` override is only honored in test mode. */
export async function startTerminal(size: { cols: number; rows: number }, signal: AbortSignal) {
  const cwd = new URL(window.location.href).searchParams.get('cwd') ?? undefined
  const response = await fetch('/api/terminal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...size, cwd }),
    signal,
  })
  const body = (await response.json()) as StartedTerminal | { error: string }
  if (!response.ok || 'error' in body) throw new Error('error' in body ? body.error : `HTTP ${response.status}`)
  return body
}

/** Reads the output stream until the shell exits or the signal aborts. */
export async function followTerminal(id: string, signal: AbortSignal, onEvent: (event: TerminalEvent) => void) {
  const response = await fetch(endpoint(id), { signal, cache: 'no-store' })
  if (!response.ok || !response.body) throw new Error(`Could not follow the terminal: HTTP ${response.status}`)
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let pending = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    pending += value
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (line) onEvent(JSON.parse(line) as TerminalEvent)
      newline = pending.indexOf('\n')
    }
  }
}

/**
 * Sends keystrokes in order. Input typed while a request is in flight is
 * batched into the next request, so fast typing does not reorder or flood.
 */
export function createInputSender(id: string) {
  let queued = ''
  let sending = false

  async function flush() {
    if (sending || !queued) return
    sending = true
    const input = queued
    queued = ''
    try {
      await fetch(endpoint(id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      })
    } finally {
      sending = false
      void flush()
    }
  }

  return (data: string) => {
    queued += data
    void flush()
  }
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  void fetch(endpoint(id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cols, rows }),
  }).catch(() => {})
}

/** Kills the shell; `keepalive` lets the request finish while the page unloads. */
export function killTerminal(id: string) {
  void fetch(endpoint(id), { method: 'DELETE', keepalive: true }).catch(() => {})
}
