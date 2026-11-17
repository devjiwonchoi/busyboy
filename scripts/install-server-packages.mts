// Installs the packages in src/lib/server-external-packages.ts as complete
// folders into a packaged server, instead of relying on what Next's file
// tracing picked: they load native binaries or files by computed paths, so a
// traced subset can miss what they need at runtime.
//
// The packages the server loads by name are installed into a temporary folder
// from the lockfile (frozen, so exactly the locked versions) as real, hoisted
// folders. Only those packages are installed: the rest of the app is not, so
// the install stays small on the slow Windows runners. The listed packages and
// everything they resolve to are copied from there.
//
// Next also traces `sharp` into the standalone output, including the build
// machine's native binary. `sharp` is not a direct dependency, so it is added
// here and installed for the machine doing the packaging. Binaries for any
// other platform are then removed.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { serverExternalPackages } from '../src/lib/server-external-packages.ts'
import { trimLockfile } from './trim-lockfile.mts'

const root = join(import.meta.dirname, '..')

// The Agent SDK installs its own `claude` executable for the host platform as
// an optional package (about 300 MB). The app runs the user's installed
// `claude`, so these are dropped.
const bundledExecutables = /^@anthropic-ai\/claude-agent-sdk-/

type Manifest = {
  name: string
  version?: string
  packageManager?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

function readManifest(packageDir: string): Manifest {
  return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
}

/** Top-level package folders in a hoisted node_modules, with scopes expanded. */
function listPackages(nodeModules: string): string[] {
  const names: string[] = []
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      for (const scoped of readdirSync(join(nodeModules, entry))) names.push(`${entry}/${scoped}`)
    } else {
      names.push(entry)
    }
  }
  return names
}

/** Node's lookup: the nearest node_modules/<name> from `fromDir` up to the install root. */
function resolvePackage(nodeModules: string, fromDir: string, name: string): string | undefined {
  let dir = fromDir
  while (dir.startsWith(nodeModules)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dir === nodeModules) break
    dir = dirname(dir)
  }
  const topLevel = join(nodeModules, name)
  return existsSync(join(topLevel, 'package.json')) ? topLevel : undefined
}

/** The top-level folder that contains `packageDir` (nested node_modules travel with it). */
function topLevelName(nodeModules: string, packageDir: string): string {
  const parts = relative(nodeModules, packageDir).split(sep)
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
}

/** Top-level folders needed by the listed packages, following dependencies the way Node resolves them. */
function dependencyClosure(nodeModules: string, names: readonly string[]): Set<string> {
  const needed = new Set<string>()
  const visited = new Set<string>()
  const queue = names.map((name) => {
    const dir = resolvePackage(nodeModules, nodeModules, name)
    if (!dir) throw new Error(`${name} was not installed from the lockfile.`)
    return dir
  })
  while (queue.length > 0) {
    const dir = queue.pop()!
    if (visited.has(dir)) continue
    visited.add(dir)
    needed.add(topLevelName(nodeModules, dir))
    const manifest = readManifest(dir)
    const required = Object.keys(manifest.dependencies ?? {})
    const optional = [...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]
    for (const dep of required) {
      const resolved = resolvePackage(nodeModules, dir, dep)
      if (!resolved) throw new Error(`${manifest.name} depends on ${dep}, which the lockfile install did not provide.`)
      queue.push(resolved)
    }
    for (const dep of optional) {
      const resolved = resolvePackage(nodeModules, dir, dep)
      if (resolved) queue.push(resolved)
    }
  }
  return needed
}

/** Keeps only the host's prebuilt binaries in packages that ship them for every platform. */
function pruneForeignPrebuilds(packageDir: string, platform: string, arch: string) {
  const prebuilds = join(packageDir, 'prebuilds')
  if (!existsSync(prebuilds)) return
  for (const target of readdirSync(prebuilds)) {
    if (target !== `${platform}-${arch}`) rmSync(join(prebuilds, target), { recursive: true, force: true })
  }
}

// node-pty 1.1.0 publishes spawn-helper without the executable bit, and it
// runs that helper for every terminal on macOS and Linux.
function makeSpawnHelperExecutable(packageDir: string, platform: string, arch: string) {
  if (platform === 'win32') return
  for (const dir of [join('prebuilds', `${platform}-${arch}`), join('build', 'Release')]) {
    const helper = join(packageDir, dir, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}

/** The lockfile snapshot Next resolved for sharp, including its peer suffix when it has one. */
function lockedSharp(lockText: string): { specifier: string; version: string } | null {
  const withPeer = /^  sharp@(\d+\.\d+\.\d+)\([^)\n]+\):/m.exec(lockText)
  if (withPeer) return { specifier: withPeer[1], version: withPeer[1] + withPeer[0].slice(`  sharp@${withPeer[1]}`.length, -1) }
  const plain = /^  sharp@(\d+\.\d+\.\d+):/m.exec(lockText)
  return plain ? { specifier: plain[1], version: plain[1] } : null
}

function quoteYaml(name: string) {
  return /[^A-Za-z0-9_-]/.test(name) ? `'${name.replaceAll("'", "''")}'` : name
}

/** Adds one root dependency the committed importer does not list. `version` is the lockfile snapshot id. */
function addLockfileDependency(lockText: string, name: string, specifier: string, version: string) {
  const newline = lockText.includes('\r\n') ? '\r\n' : '\n'
  const header = `    dependencies:${newline}`
  const entry = `      ${quoteYaml(name)}:${newline}        specifier: ${specifier}${newline}        version: ${version}${newline}`
  const at = lockText.indexOf(header)
  if (at === -1) throw new Error('The trimmed lockfile has no dependencies section to add sharp to.')
  return lockText.slice(0, at + header.length) + entry + lockText.slice(at + header.length)
}

/**
 * Deletes `@img/sharp-*` binaries that are not for `platform-arch`. A standalone
 * output built on another machine contains that machine's copy, and loading it
 * crashes the server.
 */
function removeForeignSharpPackages(serverDir: string, platform: string, arch: string) {
  const keep = new Set([`sharp-${platform}-${arch}`, `sharp-libvips-${platform}-${arch}`])
  const stack = [serverDir]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (entry.name === '@img') {
        for (const child of readdirSync(path, { withFileTypes: true })) {
          // Symlinks too: pnpm links each platform package, and a link to the
          // build machine's binary must not survive onto another platform.
          if (keep.has(child.name) || !child.name.startsWith('sharp-')) continue
          if (!child.isDirectory() && !child.isSymbolicLink()) continue
          rmSync(join(path, child.name), { recursive: true, force: true })
        }
      }
      stack.push(path)
    }
  }
}

export function installServerPackages(serverDir: string, platform: string, arch: string) {
  const manifest = readManifest(root)
  for (const name of serverExternalPackages) {
    if (!manifest.dependencies?.[name]) {
      throw new Error(`${name} is in lib/server-external-packages.ts but not in package.json dependencies.`)
    }
  }

  const lockText = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
  const sharp = lockedSharp(lockText)
  const keep = new Set<string>(serverExternalPackages)
  if (sharp) keep.add('sharp')

  const staging = mkdtempSync(join(tmpdir(), 'busyboy-server-packages-'))
  try {
    // A separate project outside the repository, so the install cannot change
    // the repository's own node_modules or install state.
    const staged: { name: string; private: true; packageManager?: string; dependencies: Record<string, string> } = {
      name: 'busyboy-server-packages',
      private: true,
      dependencies: {},
    }
    if (manifest.packageManager) staged.packageManager = manifest.packageManager
    for (const name of serverExternalPackages) staged.dependencies[name] = manifest.dependencies![name]
    if (sharp) staged.dependencies.sharp = sharp.specifier
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify(staged, null, 2)}\n`)
    let stagedLock = trimLockfile(lockText, keep)
    if (sharp && !(serverExternalPackages as readonly string[]).includes('sharp')) {
      stagedLock = addLockfileDependency(stagedLock, 'sharp', sharp.specifier, sharp.version)
    }
    writeFileSync(join(staging, 'pnpm-lock.yaml'), stagedLock)
    copyFileSync(join(root, 'pnpm-workspace.yaml'), join(staging, 'pnpm-workspace.yaml'))
    execFileSync(
      'pnpm',
      ['install', '--frozen-lockfile', '--prod', '--config.node-linker=hoisted', '--prefer-offline', '--reporter=append-only'],
      { cwd: staging, stdio: 'inherit', shell: process.platform === 'win32' },
    )
    const installed = join(staging, 'node_modules')
    for (const name of listPackages(installed)) {
      if (bundledExecutables.test(name)) rmSync(join(installed, name), { recursive: true, force: true })
    }

    const target = join(serverDir, 'node_modules')
    const roots = sharp ? [...serverExternalPackages, 'sharp'] : [...serverExternalPackages]
    for (const name of dependencyClosure(installed, roots)) {
      const from = join(installed, name)
      const to = join(target, name)
      pruneForeignPrebuilds(from, platform, arch)
      // Tracing leaves a partial copy, and a shared build leaves another platform's
      // sharp. Replace those with the package installed for this machine.
      const replace = name === 'sharp' || name.startsWith('@img/') || (serverExternalPackages as readonly string[]).includes(name)
      if (pathExists(to)) {
        if (replace) rmSync(to, { recursive: true, force: true })
        else if (readManifest(to).version === readManifest(from).version) continue
        else throw new Error(`${name} ${readManifest(from).version} conflicts with ${readManifest(to).version} in the server.`)
      }
      cpSync(from, to, { recursive: true })
      makeSpawnHelperExecutable(to, platform, arch)
    }
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  removeForeignSharpPackages(serverDir, platform, arch)
  pointAliasesAtInstalledPackages(serverDir, platform)
}

/**
 * The server does not load an external package by its name: Next links
 * `.next/node_modules/<name>-<hash>` to the traced copy and loads that, which
 * lacks the native binaries. Point each alias at the whole package instead,
 * as a relative link, or as a copy on Windows, where the server has no links.
 */
function pointAliasesAtInstalledPackages(serverDir: string, platform: string) {
  const aliases = join(serverDir, '.next', 'node_modules')
  if (!existsSync(aliases)) return
  for (const alias of listPackages(aliases)) {
    const name = serverExternalPackages.find((listed) => new RegExp(`^${escapeRegExp(listed)}-[0-9a-f]+$`).test(alias))
    if (!name) continue
    const link = join(aliases, alias)
    const installedPackage = join(serverDir, 'node_modules', name)
    rmSync(link, { recursive: true, force: true })
    if (platform === 'win32') cpSync(installedPackage, link, { recursive: true })
    else symlinkSync(relative(dirname(link), installedPackage), link)
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** True for files, folders, and links (even broken ones). */
function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
