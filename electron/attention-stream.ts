import type { AttentionUpdate } from '../src/server/attention'
import { SERVER_TOKEN_HEADER } from '../src/lib/server-token'
import type { ServerHandle } from './server-process'

const RETRY_MS = 2_000

export function followAttention(server: ServerHandle, onUpdate: (update: AttentionUpdate) => void) {
  let stopped = false
  let abort = new AbortController()
  let retry: ReturnType<typeof setTimeout> | undefined

  const connect = async () => {
    abort = new AbortController()
    try {
      const response = await fetch(`${server.url}/api/attention/events`, {
        headers: { [SERVER_TOKEN_HEADER]: server.token },
        signal: abort.signal,
      })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let pending = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        pending += value
        const blocks = pending.split('\n\n')
        pending = blocks.pop() ?? ''
        for (const block of blocks) {
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('\n')
          if (!data) continue
          try {
            onUpdate(JSON.parse(data) as AttentionUpdate)
          } catch (error) {
            console.error('busyboy: could not read an attention update', error)
          }
        }
      }
    } catch (error) {
      if (!stopped && !abort.signal.aborted) console.warn(`busyboy: the attention stream dropped: ${String(error)}`)
    }
    if (!stopped && server.isRunning()) retry = setTimeout(() => void connect(), RETRY_MS)
  }

  void connect()
  return () => {
    stopped = true
    clearTimeout(retry)
    abort.abort()
  }
}
