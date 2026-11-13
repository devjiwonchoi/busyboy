import { connection } from 'next/server'
import { startTerminal } from '@/server/terminal'
import { currentWorkingDirectory } from '@/server/working-directory'

type StartRequest = { cols?: number; rows?: number; cwd?: string }

/** Starts a terminal in the current working directory. */
export async function POST(request: Request) {
  await connection()
  const body = (await request.json().catch(() => ({}))) as StartRequest
  const cwd = currentWorkingDirectory({ testOverride: body.cwd })
  try {
    const terminal = startTerminal({ cwd, cols: Number(body.cols ?? 80), rows: Number(body.rows ?? 24) })
    return Response.json(terminal, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Response.json({ error: `Could not start a terminal: ${message}` }, { status: 500 })
  }
}
