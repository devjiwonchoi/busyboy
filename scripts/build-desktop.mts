// Packages the desktop app with electron-builder.
//
//   node scripts/build-desktop.mts [--skip-next] [--mac | --win | --linux]
//
// The Electron main process goes into app.asar. The standalone Next server is
// copied next to it into `<Resources>/server`, outside the archive, because
// `utilityProcess.fork` cannot start a server that lives inside app.asar.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import builder from 'electron-builder'

const root = join(import.meta.dirname, '..')
const args = new Set(process.argv.slice(2))
const standalone = join(root, '.next', 'standalone')
const outputDir = join(root, 'release')

function run(command: string, commandArgs: string[]) {
  execFileSync(command, commandArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
}

function targetPlatform() {
  if (args.has('--mac')) return builder.Platform.MAC
  if (args.has('--win')) return builder.Platform.WINDOWS
  if (args.has('--linux')) return builder.Platform.LINUX
  return builder.Platform.current()
}

if (!args.has('--skip-next')) run('pnpm', ['build'])
if (!existsSync(join(standalone, 'server.js'))) {
  throw new Error('No .next/standalone/server.js. Run `pnpm build` first.')
}
run('pnpm', ['build:electron'])

rmSync(outputDir, { recursive: true, force: true })

const platform = targetPlatform()

await builder.build({
  targets: platform.createTarget('dir'),
  config: {
    appId: 'dev.busyboy.desktop',
    productName: 'Busyboy',
    directories: { output: outputDir },
    // Only the bundled main process goes into app.asar; the server brings its own node_modules.
    files: ['dist-electron/**/*', 'package.json', '!node_modules/**/*'],
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    electronLanguages: ['en'],
    mac: {
      category: 'public.app-category.developer-tools',
      // Unsigned until code signing is set up.
      identity: null,
    },
    afterPack: async (context) => {
      const resources =
        context.electronPlatformName === 'darwin'
          ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
          : join(context.appOutDir, 'resources')
      // pnpm's standalone node_modules is symlinks into .pnpm. Keep them as
      // relative links on macOS and Linux; Windows gets real copies.
      cpSync(standalone, join(resources, 'server'), {
        recursive: true,
        verbatimSymlinks: context.electronPlatformName !== 'win32',
        dereference: context.electronPlatformName === 'win32',
      })
    },
  },
})

console.log(`[build-desktop] Packaged into ${outputDir}`)
