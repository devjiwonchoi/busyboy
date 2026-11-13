import { connection } from 'next/server'
import { dataFolder } from '@/server/config'
import { subscribeToMaster, type MasterUpdate } from '@/server/master-chat'

const HEARTBEAT_MS = 15_000

/** Server-sent events for the master chat: a `reset` with the whole chat, then every change. */
export async function GET(request: Request) {
  await connection()
  const folder = await dataFolder()
  const encoder = new TextEncoder()
  let cleanup = () => {}

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const send = (update: MasterUpdate) => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(update)}\n\n`))
      }
      const unsubscribe = await subscribeToMaster(folder, send)
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
