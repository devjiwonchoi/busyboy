import { connection } from 'next/server'
import { attachTerminal, killTerminal, resizeTerminal, writeTerminal, type TerminalEvent } from '@/server/terminal'

type Context = { params: Promise<{ id: string }> }

const notFound = () => Response.json({ error: 'No such terminal.' }, { status: 404 })

/**
 * Streams the terminal's output as newline-delimited JSON events. The stream
 * stays open until the shell exits or the client goes away.
 */
export async function GET(request: Request, { params }: Context) {
  await connection()
  const { id } = await params
  const encoder = new TextEncoder()
  let detach: (() => void) | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: TerminalEvent) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
          if (event.type === 'exit') controller.close()
        } catch {
          // The client already went away; stop following.
          detach?.()
        }
      }
      detach = attachTerminal(id, send)
      if (!detach) {
        send({ type: 'exit', exitCode: -1, killed: true })
        return
      }
      request.signal.addEventListener('abort', () => detach?.(), { once: true })
    },
    cancel() {
      detach?.()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}

type UpdateRequest = { input?: string; cols?: number; rows?: number }

/** Sends keyboard input and/or a new size to the terminal. */
export async function POST(request: Request, { params }: Context) {
  const { id } = await params
  const body = (await request.json().catch(() => null)) as UpdateRequest | null
  if (!body) return Response.json({ error: 'Expected a JSON body.' }, { status: 400 })
  if (typeof body.input === 'string' && !writeTerminal(id, body.input)) return notFound()
  if (body.cols !== undefined && body.rows !== undefined && !resizeTerminal(id, Number(body.cols), Number(body.rows))) {
    return notFound()
  }
  return new Response(null, { status: 204 })
}

/** Kills the terminal's shell. */
export async function DELETE(_request: Request, { params }: Context) {
  const { id } = await params
  return killTerminal(id) ? new Response(null, { status: 204 }) : notFound()
}
