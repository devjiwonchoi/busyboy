// Copies the assets that `output: 'standalone'` leaves out, so
// `.next/standalone/server.js` can serve the full app on its own.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const standalone = join(root, '.next', 'standalone')

if (!existsSync(join(standalone, 'server.js'))) {
  throw new Error('No .next/standalone/server.js. Run `next build` first.')
}

const copies = [
  [join(root, '.next', 'static'), join(standalone, '.next', 'static')],
  [join(root, 'public'), join(standalone, 'public')],
] as const

for (const [from, to] of copies) {
  if (!existsSync(from)) continue
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true })
}
