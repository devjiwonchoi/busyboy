// utilityProcess.fork cannot start a server that lives inside app.asar.
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import builder from 'electron-builder'
import { checkPackagedServer } from './check-packaged-server.mts'
import { installServerPackages } from './install-server-packages.mts'
import { materializeWindowsServer } from './materialize-windows-server.mts'

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

// Native modules are built for this machine, so the platform flag has to match it.
function targetPlatform() {
  const requested = args.has('--mac') ? 'darwin' : args.has('--win') ? 'win32' : args.has('--linux') ? 'linux' : null
  if (requested && requested !== process.platform) {
    throw new Error(`Cannot package for ${requested} on ${process.platform}; build on that platform instead.`)
  }
  return builder.Platform.current()
}

const platform = targetPlatform()
const version = releaseVersion()
const release = args.has('--release')
const mac = process.platform === 'darwin'

const APP_ID = 'dev.jiwon.busyboy'
const DEVELOPER_TEAM = '5PA4R2B5FF'
/** The requirement BusyBoy 0.0.22 and earlier check before they install an update. */
const SIGNATURE_REQUIREMENT = `anchor apple generic and identifier "${APP_ID}" and certificate leaf[subject.OU] = "${DEVELOPER_TEAM}"`

if (release && mac) {
  // electron-builder would skip notarization without these and ship an app Gatekeeper refuses.
  const missing = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].filter((name) => !process.env[name])
  if (missing.length > 0) throw new Error(`A macOS release needs ${missing.join(', ')} to notarize the app.`)
}
if (release && process.platform === 'linux') throw new Error('Releases are built for macOS and Windows only.')

if (!args.has('--skip-next')) run('pnpm', ['build'])
if (!existsSync(join(standalone, 'server.js'))) {
  throw new Error('No .next/standalone/server.js. Run `pnpm build` first.')
}
if (!args.has('--skip-electron')) run('pnpm', ['build:electron'])
else if (!existsSync(join(root, 'dist-electron', 'main.cjs'))) {
  throw new Error('No dist-electron/main.cjs. Run `pnpm build:electron` first.')
}

rmSync(outputDir, { recursive: true, force: true })

// Release jobs install only electron and electron-builder, but electron-builder still requires every production dependency.
const packagePath = join(root, 'package.json')
const packageBackup = args.has('--skip-next') ? readFileSync(packagePath) : null
if (packageBackup) {
  const packaged = JSON.parse(packageBackup.toString('utf8')) as Record<string, unknown>
  delete packaged.dependencies
  delete packaged.optionalDependencies
  writeFileSync(packagePath, `${JSON.stringify(packaged, null, 2)}\n`)
}

let packagedServer: string | undefined
let executable: string | undefined

const entitlements = join(root, 'electron', 'entitlements.mac.plist')

try {
await builder.build({
  targets: platform.createTarget(release ? (mac ? ['dmg', 'zip'] : ['nsis']) : 'dir'),
  publish: 'never',
  config: {
    appId: APP_ID,
    productName: manifest.productName,
    ...(release
      ? {
          // BusyBoy-0.0.23-arm64.zip: the name installed apps look for in a release.
          artifactName: '${productName}-${version}-${arch}.${ext}',
          // Makes electron-builder write the update feed files (latest.yml,
          // latest-mac.yml) and the app-update.yml that tells the app where they are.
          publish: [{ provider: 'github' as const, owner: 'devjiwonchoi', repo: 'busyboy', releaseType: 'release' as const }],
          // macOS: fail instead of shipping an unsigned app when no Developer ID is found.
          forceCodeSigning: mac,
          nsis: {
            artifactName: '${productName}-Setup-${version}-${arch}.${ext}',
            differentialPackage: true,
          },
          dmg: {
            title: `${manifest.productName} ${version}`,
            contents: [
              { x: 166, y: 214, type: 'file' as const },
              { x: 474, y: 214, type: 'link' as const, path: '/Applications' },
            ],
          },
        }
      : {}),
    extraMetadata: { version },
    directories: { output: outputDir },
    // Only the bundled main process goes into app.asar; the server brings its own node_modules.
    files: ['dist-electron/**/*', 'package.json', '!node_modules/**/*'],
    asar: true,
    // Nothing to rebuild: app.asar has no native modules, and the server's
    // come prebuilt from the lockfile install below.
    npmRebuild: false,
    nodeGypRebuild: false,
    electronLanguages: ['en'],
    win: { icon: join(root, 'electron', 'icons', 'icon.ico') },
    linux: { icon: join(root, 'electron', 'icons', 'icon.png') },
    mac: {
      icon: join(root, 'electron', 'icons', 'icon.png'),
      category: 'public.app-category.developer-tools',
      ...(release
        ? {
            // Notarization requires the hardened runtime; the entitlements are what V8 needs under it.
            hardenedRuntime: true,
            entitlements,
            entitlementsInherit: entitlements,
            notarize: true,
          }
        :
          { identity: null }),
    },
    afterPack: async (context) => {
      if (packageBackup) writeFileSync(packagePath, packageBackup)
      const { productFilename } = context.packager.appInfo
      const mac = context.electronPlatformName === 'darwin'
      const resources = mac
        ? join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
        : join(context.appOutDir, 'resources')
      executable = mac
        ? join(context.appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename)
        : join(
            context.appOutDir,
            context.electronPlatformName === 'win32' ? `${productFilename}.exe` : context.packager.appInfo.sanitizedName.toLowerCase(),
          )
      // Windows cannot use pnpm's symlinks, so each package is copied with its siblings nested inside.
      packagedServer = join(resources, 'server')
      if (context.electronPlatformName === 'win32') materializeWindowsServer(standalone, packagedServer)
      else cpSync(standalone, packagedServer, { recursive: true, verbatimSymlinks: true })
      const strays = ['.git', 'tests', 'release', 'scripts', 'electron'].filter((name) => existsSync(join(packagedServer as string, name)))
      if (strays.length > 0) throw new Error(`The packaged server contains repository files: ${strays.join(', ')}.`)
      installServerPackages(packagedServer, context.electronPlatformName, builder.Arch[context.arch])
    },
  },
})
} finally {
  if (packageBackup) writeFileSync(packagePath, packageBackup)
}

if (!packagedServer || !executable) throw new Error('electron-builder did not run the afterPack step.')
await checkPackagedServer(packagedServer)

if (release && mac) {
  const appBundle = join(executable, '..', '..', '..')
  if (APP_ID !== 'dev.jiwon.busyboy' || DEVELOPER_TEAM !== '5PA4R2B5FF') {
    throw new Error('Installed apps only accept the bundle id dev.jiwon.busyboy signed by team 5PA4R2B5FF.')
  }
  // Gatekeeper's own check that the app is signed and notarized.
  execFileSync('spctl', ['--assess', '--type', 'execute', '-vv', appBundle], { stdio: 'inherit' })
  const signed = spawnSync('codesign', ['-d', '--verbose=2', appBundle], { encoding: 'utf8' })
  const details = `${signed.stdout ?? ''}\n${signed.stderr ?? ''}`
  if (!details.includes(`Identifier=${APP_ID}`) || !details.includes(`TeamIdentifier=${DEVELOPER_TEAM}`)) {
    throw new Error(`The signed app is not ${APP_ID} from team ${DEVELOPER_TEAM}.\n${details}`)
  }
  // BusyBoy 0.0.22 unpacks the ZIP with ditto and checks this signature requirement.
  const zip = join(outputDir, `${manifest.productName}-${version}-${builder.Arch[builder.archFromString(process.arch)]}.zip`)
  const unpacked = mkdtempSync(join(tmpdir(), 'busyboy-update-check-'))
  try {
    execFileSync('ditto', ['-x', '-k', zip, unpacked], { stdio: 'inherit' })
    execFileSync('codesign', ['--verify', '--deep', '--strict', `-R=${SIGNATURE_REQUIREMENT}`, join(unpacked, basename(appBundle))], {
      stdio: 'inherit',
    })
  } finally {
    rmSync(unpacked, { recursive: true, force: true })
  }
}
writeFileSync(
  join(outputDir, 'desktop-build.json'),
  `${JSON.stringify({ productName: manifest.productName, version, executable, server: packagedServer }, null, 2)}\n`,
)

console.log(`[build-desktop] Packaged into ${outputDir}`)
