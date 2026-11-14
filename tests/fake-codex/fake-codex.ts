import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100)

/** Where the fake `codex` (tests/fake-codex/codex.mjs) writes the pids of the children it starts. */
export const fakeCodexPidFile = join(tmpdir(), `busyboy-fake-codex-${port}.pid`)
