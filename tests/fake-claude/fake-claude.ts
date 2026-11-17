import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100)

export const fakeClaudePort = port + 1
export const fakeClaudeURL = `http://127.0.0.1:${fakeClaudePort}`

export const fakeClaudePidFile = join(tmpdir(), `busyboy-fake-claude-${fakeClaudePort}.pid`)
