// Copies the assets that `output: 'standalone'` leaves out, so
// `.next/standalone/server.js` can serve the full app on its own, and
// installs the packages in src/lib/server-external-packages.ts whole, as the
// desktop build does, since tracing misses their native binaries.
//
//   node scripts/prepare-standalone.mts [--assets-only]
//
// --assets-only skips the native-package install. The release workflow builds
// the standalone output once. macOS keeps pnpm's symlinks. Windows gets a
// copy where each package contains its pnpm siblings, so Node can resolve
// them without the links. Each platform installs its
// own native modules when it packages the app.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { installServerPackages } from './install-server-packages.mts'

const root = join(import.meta.dirname, '..')
const standalone = join(root, '.next', 'standalone')
const assetsOnly = process.argv.includes('--assets-only')

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

if (!assetsOnly) installServerPackages(standalone, process.platform, process.arch)
