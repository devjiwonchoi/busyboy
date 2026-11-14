// Bundles the Electron main process and the window's preload script into dist-electron/.
import { join } from 'node:path'
import { build } from 'esbuild'

const root = join(import.meta.dirname, '..')

await build({
  entryPoints: {
    main: join(root, 'electron', 'main.ts'),
    // Sandboxed preload scripts cannot require other files, so it is bundled on its own.
    preload: join(root, 'electron', 'preload.ts'),
  },
  outdir: join(root, 'dist-electron'),
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: 'linked',
  logLevel: 'warning',
})
