import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100)

/** The server that runs the real Claude adapter against tests/fake-claude/claude.sh. */
export const fakeClaudePort = port + 1
export const fakeClaudeURL = `http://127.0.0.1:${fakeClaudePort}`

/** Where the fake CLI writes the pids of the children it starts. */
export const fakeClaudePidFile = join(tmpdir(), `busyboy-fake-claude-${fakeClaudePort}.pid`)
