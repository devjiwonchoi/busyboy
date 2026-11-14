import { connection } from 'next/server'
import { decideHookCall } from '@/server/runner/codex-always-ask'

/** How often a waiting response sends a space, well inside fetch's five-minute idle timeout. */
const KEEP_ALIVE_MS = 30_000

/**
 * Codex's always-ask hook posts each tool call here (see codex-always-ask.ts)
 * and gets `{ allow, reason }` once the session decides, which may be after the
 * user answers an approval card. Until then the response sends spaces, which
 * the hook trims before it reads the JSON.
 */
export async function POST(request: Request) {
  await connection()
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body.tool_name !== 'string') {
    return Response.json({ allow: false, reason: 'BusyBoy could not read the tool call.' }, { status: 400 })
  }
  const decision = decideHookCall({
    call: {
      sessionId: typeof body.session_id === 'string' ? body.session_id : undefined,
      cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
      toolName: body.tool_name,
      input: body.tool_input,
    },
    // Aborts when the hook disconnects, so its approval card closes instead of waiting for nobody.
    signal: request.signal,
  })

  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setInterval> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => controller.enqueue(encoder.encode(' ')), KEEP_ALIVE_MS)
      decision
        .catch((error: unknown) => ({ allow: false, reason: error instanceof Error ? error.message : String(error) }))
        .then((result) => {
          clearInterval(timer)
          controller.enqueue(encoder.encode(JSON.stringify(result)))
          controller.close()
        })
        .catch(() => {
          // The hook went away (its turn was interrupted); the session already dropped the request.
        })
    },
    cancel() {
      clearInterval(timer)
    },
  })
  return new Response(stream, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' } })
}
