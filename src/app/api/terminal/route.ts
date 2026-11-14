import { connection } from 'next/server'
import { startTerminal } from '@/server/terminal'
import { TaskError } from '@/server/tasks'
import { currentWorkingDirectory } from '@/server/working-directory'

type StartRequest = { cols?: unknown; rows?: unknown; cwd?: unknown; taskId?: unknown }

const stringOrNull = (value: unknown) => (typeof value === 'string' ? value : null)

/** Starts a terminal in the selected task's worktree, or in the home folder when no task is selected. */
export async function POST(request: Request) {
  await connection()
  const body = (await request.json().catch(() => ({}))) as StartRequest
  let directory
  try {
    directory = await currentWorkingDirectory({ taskId: stringOrNull(body.taskId), testOverride: stringOrNull(body.cwd) })
  } catch (error) {
    if (error instanceof TaskError) {
      return Response.json({ error: error.message }, { status: 400 })
    }
    throw error
  }
  try {
    const terminal = startTerminal({ cwd: directory.cwd, cols: Number(body.cols ?? 80), rows: Number(body.rows ?? 24) })
    return Response.json({ ...terminal, task: directory.task }, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return Response.json({ error: `Could not start a terminal: ${message}` }, { status: 500 })
  }
}
