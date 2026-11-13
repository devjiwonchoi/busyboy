// Packages the desktop app with electron-builder.
//
//   node scripts/build-desktop.mts [--skip-next] [--version <x.y.z>] [--mac | --win | --linux]
//
// package.json stays at 0.0.0; a release passes its version with --version.
// The result, including the path of the packaged executable, is written to
// release/desktop-build.json for CI and other scripts.
//
// The platform flag must match the machine; cross-packaging is refused.
//
// The Electron main process goes into app.asar. The standalone Next server is
// copied next to it into `<Resources>/server`, outside the archive, because
// `utilityProcess.fork` cannot start a server that lives inside app.asar. The
// packages in src/lib/server-external-packages.ts are then installed into it as
// whole folders, and the build fails unless that server works on its own.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import builder from 'electron-builder'
import { checkPackagedServer } from './check-packaged-server.mts'
import { installServerPackages } from './install-server-packages.mts'

const root = join(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const args = new Set(argv)
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function releaseVersion(): string {
  const index = argv.findIndex((arg) => arg === '--version' || arg.startsWith('--version='))
  if (index === -1) return manifest.version
  const value = argv[index].includes('=') ? argv[index].slice('--version='.length) : argv[index + 1]
  if (!value || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`--version needs a version such as 0.0.23, got ${value ?? 'nothing'}.`)
  }
  return value
}
const standalone = join(root, '.next', 'standalone')
const outputDir = join(root, 'release')

function run(command: string, commandArgs: string[]) {
  execFileSync(command, commandArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
}

// The standalone server carries native modules built for this machine
// (for example sharp), so the app can only be packaged for the host platform.
function targetPlatform() {
  const requested = args.has('--mac') ? 'darwin' : args.has('--win') ? 'win32' : args.has('--linux') ? 'linux' : null
  if (requested && requested !== process.platform) {
    throw new Error(`Cannot package for ${requested} on ${process.platform}; build on that platform instead.`)
  }
  return builder.Platform.current()
}

// Check the arguments before building, so a typo neither costs a build nor deletes the last release.
const platform = targetPlatform()
const version = releaseVersion()

if (!args.has('--skip-next')) run('pnpm', ['build'])
if (!existsSync(join(standalone, 'server.js'))) {
  throw new Error('No .next/standalone/server.js. Run `pnpm build` first.')
}
run('pnpm', ['build:electron'])

rmSync(outputDir, { recursive: true, force: true })

let packagedServer: string | undefined
let executable: string | undefined

await builder.build({
  targets: platform.createTarget('dir'),
  config: {
    // Same identity as the previous app, so a release replaces it on install.
    appId: 'dev.jiwon.busyboy',
    productName: manifest.productName,
    extraMetadata: { version },
    directories: { output: outputDir },
    // Only the bundled main process goes into app.asar; the server brings its own node_modules.
    files: ['dist-electron/**/*', 'package.json', '!node_modules/**/*'],
    asar: true,
    // Nothing to rebuild: app.asar has no native modules, and the server's
    // come prebuilt from the lockfile install below.
    npmRebuild: false,
    nodeGypRebuild: false,
    // The UI is English only, so Chromium's other locale files are dropped.
    electronLanguages: ['en'],
    mac: {
      category: 'public.app-category.developer-tools',
      // Unsigned until code signing is set up.
      identity: null,
    },
    afterPack: async (context) => {
      const { productFilename } = context.packager.appInfo
      const mac = context.electronPlatformName === 'darwin'
      const resources = mac
        ? join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
        : join(context.appOutDir, 'resources')
      executable = mac
        ? join(context.appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename)
        : join(
            context.appOutDir,
            // electron-builder names the Linux binary after the lowercased sanitized app name.
            context.electronPlatformName === 'win32' ? `${productFilename}.exe` : context.packager.appInfo.sanitizedName.toLowerCase(),
          )
      // pnpm's standalone node_modules is symlinks into .pnpm. Keep them as
      // relative links on macOS and Linux; Windows gets real copies.
      packagedServer = join(resources, 'server')
      cpSync(standalone, packagedServer, {
        recursive: true,
        verbatimSymlinks: context.electronPlatformName !== 'win32',
        dereference: context.electronPlatformName === 'win32',
      })
      installServerPackages(packagedServer, context.electronPlatformName, builder.Arch[context.arch])
    },
  },
})

if (!packagedServer || !executable) throw new Error('electron-builder did not run the afterPack step.')
await checkPackagedServer(packagedServer)
writeFileSync(
  join(outputDir, 'desktop-build.json'),
  `${JSON.stringify({ productName: manifest.productName, version, executable, server: packagedServer }, null, 2)}\n`,
)

console.log(`[build-desktop] Packaged into ${outputDir}`)
