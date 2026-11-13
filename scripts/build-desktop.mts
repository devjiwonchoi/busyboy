// Packages the desktop app with electron-builder.
//
//   node scripts/build-desktop.mts [--skip-next] [--mac | --win | --linux]
//
// The Electron main process goes into app.asar. The standalone Next server is
// copied next to it into `<Resources>/server`, outside the archive, because
// `utilityProcess.fork` cannot start a server that lives inside app.asar.
// The terminal's native module (node-pty) travels inside that server folder.
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, readdirSync, rmSync } from 'node:fs'
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
 * node-pty ships N-API prebuilds, so one binary works in Node and in
 * Electron's utility process without a rebuild. Keep only the target's
 * prebuilds (both architectures for a universal macOS build), keep a binary
 * compiled into `build/Release` when there is one, and make sure
 * `spawn-helper` stays executable.
 */
function pruneNodePty(serverDir: string, platform: string, arch: string) {
  const targets = arch === 'universal' ? [`${platform}-x64`, `${platform}-arm64`] : [`${platform}-${arch}`]
  const packages: string[] = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Symlinks point at folders this walk reaches anyway.
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (/^node-pty(-[0-9a-f]+)?$/.test(entry.name) && existsSync(join(path, 'package.json'))) {
        packages.push(path)
        continue
      }
      visit(path)
    }
  }
  visit(serverDir)
  if (packages.length === 0) throw new Error('node-pty is missing from the packaged server.')

  for (const dir of packages) {
    const prebuilds = join(dir, 'prebuilds')
    if (existsSync(prebuilds)) {
      for (const build of readdirSync(prebuilds)) {
        if (!targets.includes(build)) rmSync(join(prebuilds, build), { recursive: true, force: true })
      }
    }
    const binaryDirs = [join(dir, 'build', 'Release'), ...targets.map((target) => join(prebuilds, target))]
    for (const binaryDir of binaryDirs) {
      const helper = join(binaryDir, 'spawn-helper')
      if (existsSync(helper)) chmodSync(helper, 0o755)
    }
    const compiled = existsSync(join(dir, 'build', 'Release', 'pty.node'))
    const missing = targets.filter((target) => !existsSync(join(prebuilds, target, 'pty.node')))
    if (!compiled && missing.length > 0) {
      throw new Error(`node-pty in ${dir} has no binary for ${missing.join(', ')}.`)
    }
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
      pruneNodePty(join(resources, 'server'), context.electronPlatformName, builder.Arch[context.arch])
    },
  },
})

console.log(`[build-desktop] Packaged into ${outputDir}`)
