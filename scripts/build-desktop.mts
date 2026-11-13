// Packages the desktop app with electron-builder.
//
//   node scripts/build-desktop.mts [--skip-next] [--mac | --win | --linux]
//
// The Electron main process goes into app.asar. The standalone Next server is
// copied next to it into `<Resources>/server`, outside the archive, because
// `utilityProcess.fork` cannot start a server that lives inside app.asar.
// The terminal's native module (node-pty) travels inside that server folder.
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
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

/**
 * node-pty ships N-API prebuilds for every platform, so one binary works in
 * Node and in Electron's utility process without a rebuild. Keep only the
 * target's folder and make sure macOS keeps `spawn-helper` executable.
 */
function pruneNodePty(serverDir: string, target: string) {
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Symlinks point at folders this walk reaches anyway.
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (entry.name === 'prebuilds' && /node-pty(-[0-9a-f]+)?$/.test(dir)) {
        for (const build of readdirSync(path)) {
          if (build !== target) rmSync(join(path, build), { recursive: true, force: true })
        }
        const helper = join(path, target, 'spawn-helper')
        if (existsSync(helper)) chmodSync(helper, 0o755)
        continue
      }
      visit(path)
    }
  }
  visit(serverDir)
  const kept = join(serverDir, 'node_modules', 'node-pty', 'prebuilds', target)
  if (!existsSync(kept) || !lstatSync(kept).isDirectory()) {
    throw new Error(`node-pty has no prebuilt binary for ${target} in the packaged server.`)
  }
}

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
      pruneNodePty(join(resources, 'server'), `${context.electronPlatformName}-${builder.Arch[context.arch]}`)
    },
  },
})

console.log(`[build-desktop] Packaged into ${outputDir}`)
