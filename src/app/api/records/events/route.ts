import { connection } from 'next/server'
import { dataFolder } from '@/server/config'
import type { ProjectGraph } from '@/server/records/project-graph'
import { subscribeToProjectGraph } from '@/server/records/record-watcher'

const HEARTBEAT_MS = 15_000

/** Server-sent events for the Projects tab: the whole project graph now and after every change. */
export async function GET(request: Request) {
  await connection()
  const folder = await dataFolder()
  const encoder = new TextEncoder()
  let closed = false
  let cleanup = () => {}

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          // The stream closed under us; stop sending.
          closed = true
          cleanup()
        }
      }
      const unsubscribe = await subscribeToProjectGraph(folder, (graph: ProjectGraph) => send(`data: ${JSON.stringify(graph)}\n\n`))
      const heartbeat = setInterval(() => send(': keep-alive\n\n'), HEARTBEAT_MS)
      let cleaned = false
      cleanup = () => {
        closed = true
        if (cleaned) return
        cleaned = true
        clearInterval(heartbeat)
        unsubscribe()
      }
      // The client may have gone while the graph was being read.
      if (closed || request.signal.aborted) cleanup()
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
