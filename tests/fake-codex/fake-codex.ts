import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100);

export const fakeCodexPidFile = join(tmpdir(), `busyboy-fake-codex-${port}.pid`);
