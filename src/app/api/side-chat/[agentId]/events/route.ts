import { connection } from 'next/server'
import { isSideAgentStopped, subscribeToSideAgent } from '@/server/director/side-chat'
import type { AgentEventEnvelope } from '@/server/runner/contract'

const HEARTBEAT_MS = 15_000

/**
 * Server-sent events for one side agent: every event after `Last-Event-ID`
 * (or `?after=`, where one answer of a longer side chat starts), then live
 * events. The stream ends with `end` after the agent stops, and
 * sends `missing` for an id that is not a side agent.
 */
export async function GET(request: Request, { params }: RouteContext<'/api/side-chat/[agentId]/events'>) {
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
        cleanup()
        controller.enqueue(encoder.encode('event: end\ndata: {}\n\n'))
        controller.close()
      }
      const send = (envelope: AgentEventEnvelope) => {
        if (closed) return
        controller.enqueue(encoder.encode(`id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`))
        // After the listener returns, so `cleanup` is set even for a replayed `stopped`.
        if (envelope.event.type === 'stopped') queueMicrotask(() => isSideAgentStopped(agentId) && close())
      }
      const unsubscribe = subscribeToSideAgent(agentId, after, send)
      if (!unsubscribe) {
        closed = true
        controller.enqueue(encoder.encode(`event: missing\ndata: ${JSON.stringify({ agentId })}\n\n`))
        controller.close()
        return
      }
      const heartbeat = setInterval(() => !closed && controller.enqueue(encoder.encode(': keep-alive\n\n')), HEARTBEAT_MS)
      cleanup = () => {
        // Also on cancel: a queued close() must not write to a cancelled stream.
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
