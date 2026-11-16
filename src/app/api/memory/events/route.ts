import { connection } from 'next/server'
import { dataFolder } from '@/server/config'
import { listMemoryAt, subscribeToMemory } from '@/server/memory'

const HEARTBEAT_MS = 15_000

/** Server-sent events for the Memory tab: every scope with its facts, now and after each change. */
export async function GET(request: Request) {
  await connection()
  const folder = await dataFolder()
  const encoder = new TextEncoder()
  let cleanup = () => {}

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      // Changes can arrive while a snapshot is being read; send them in order.
      let sending = Promise.resolve()
      const send = () => {
        sending = sending.then(async () => {
          const scopes = await listMemoryAt(folder).catch(() => null)
          if (!closed && scopes) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ scopes })}\n\n`))
        })
      }
      const unsubscribe = subscribeToMemory(folder, send)
      send()
      const heartbeat = setInterval(() => !closed && controller.enqueue(encoder.encode(': keep-alive\n\n')), HEARTBEAT_MS)
      cleanup = () => {
        closed = true
        clearInterval(heartbeat)
        unsubscribe()
      }
      if (request.signal.aborted) cleanup()
      request.signal.addEventListener('abort', () => cleanup())
    },
    cancel() {
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
