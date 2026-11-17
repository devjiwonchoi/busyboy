import { connection } from 'next/server'
import { dataFolder } from '@/server/config'
import { readEndStateAchievement } from '@/server/records/end-state'
import { syncEndStateCards } from '@/server/records/end-state-cards'

const HEARTBEAT_MS = 15_000
const REFRESH_MS = 1_000

/**
 * Server-sent events for the Week tab: end state achievement from the records
 * on main, now and again whenever those commits move. Done cards are opened
 * from the same read.
 */
export async function GET(request: Request) {
  await connection()
  const folder = await dataFolder()
  const encoder = new TextEncoder()
  let closed = false
  let cleanup = () => {}

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let last = ''
      let reading = false
      const send = (text: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          closed = true
          cleanup()
        }
      }
      const tick = () => {
        if (reading || closed) return
        reading = true
        readEndStateAchievement(folder)
          .then(async (result) => {
            if (closed) return
            if (result.ok) await syncEndStateCards(folder, result.tasks).catch((error: unknown) => console.error('[achievement] cards', error))
            const json = JSON.stringify(result.ok ? { weeks: result.weeks } : { error: result.error })
            if (json !== last) {
              last = json
              send(`data: ${json}\n\n`)
            }
          })
          .catch((error: unknown) => {
            console.error('[achievement] read', error)
          })
          .finally(() => {
            reading = false
          })
      }
      tick()
      const refresh = setInterval(tick, REFRESH_MS)
      const heartbeat = setInterval(() => send(': keep-alive\n\n'), HEARTBEAT_MS)
      cleanup = () => {
        closed = true
        clearInterval(refresh)
        clearInterval(heartbeat)
      }
      if (request.signal.aborted) cleanup()
      request.signal.addEventListener('abort', () => cleanup())
    },
    cancel() {
      closed = true
      cleanup()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
