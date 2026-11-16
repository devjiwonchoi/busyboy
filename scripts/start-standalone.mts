// Starts the standalone Next server on the loopback interface only.
//
//   PORT=3100 node scripts/start-standalone.mts
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const server = join(import.meta.dirname, '..', '.next', 'standalone', 'server.js')
if (!existsSync(server)) {
  throw new Error('No .next/standalone/server.js. Run `pnpm build` first.')
}

// server.js binds to HOSTNAME, falling back to 0.0.0.0.
process.env.HOSTNAME = '127.0.0.1'
process.env.PORT ??= '3000'

await import(pathToFileURL(server).href)
