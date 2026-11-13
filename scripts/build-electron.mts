// Bundles the Electron main process into dist-electron/.
import { join } from 'node:path'
import { build } from 'esbuild'

const root = join(import.meta.dirname, '..')

await build({
  entryPoints: [join(root, 'electron', 'main.ts')],
  outfile: join(root, 'dist-electron', 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: 'linked',
  logLevel: 'warning',
})
