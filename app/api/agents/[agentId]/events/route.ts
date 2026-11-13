import { connection } from 'next/server'
import { getAgent, subscribeToAgent } from '@/server/runner/agent-runner'
import type { AgentEventEnvelope } from '@/server/runner/contract'

const HEARTBEAT_MS = 15_000

/**
 * Server-sent events for one agent: every event after `Last-Event-ID` (or
 * `?after=`), then live events. The stream ends after the agent stops.
 */
export async function GET(request: Request, { params }: RouteContext<'/api/agents/[agentId]/events'>) {
  await connection()
  const { agentId } = await params
  const after = Number(request.headers.get('last-event-id') ?? new URL(request.url).searchParams.get('after') ?? 0) || 0
  const encoder = new TextEncoder()
  let cleanup = () => {}

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        cleanup()
        controller.enqueue(encoder.encode('event: end\ndata: {}\n\n'))
        controller.close()
      }
      const send = (envelope: AgentEventEnvelope) => {
        if (closed) return
        controller.enqueue(encoder.encode(`id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`))
        // A replayed `stopped` of an agent that was resumed since must not end the stream.
        if (envelope.event.type === 'stopped') {
          queueMicrotask(() => getAgent(agentId)?.status === 'stopped' && close())
        }
      }
      const unsubscribe = subscribeToAgent(agentId, after, send)
      if (!unsubscribe) {
        controller.enqueue(encoder.encode(`event: missing\ndata: ${JSON.stringify({ agentId })}\n\n`))
        controller.close()
        closed = true
        return
      }
      const heartbeat = setInterval(() => controller.enqueue(encoder.encode(': keep-alive\n\n')), HEARTBEAT_MS)
      cleanup = () => {
        clearInterval(heartbeat)
        unsubscribe()
      }
      request.signal.addEventListener('abort', () => {
        closed = true
        cleanup()
      })
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
