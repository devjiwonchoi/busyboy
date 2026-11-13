// Installs the packages in src/lib/server-external-packages.ts as complete
// folders into a packaged server, instead of relying on what Next's file
// tracing picked: they load native binaries or files by computed paths, so a
// traced subset can miss what they need at runtime.
//
// The app's production dependencies are installed into a temporary folder
// from copies of package.json, pnpm-lock.yaml, and pnpm-workspace.yaml
// (frozen, so exactly the locked versions) as real, hoisted folders. The
// listed packages and everything they resolve to are copied from there.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { serverExternalPackages } from '../src/lib/server-external-packages.ts'

const root = join(import.meta.dirname, '..')

// The Agent SDK installs its own `claude` executable for the host platform as
// an optional package (about 300 MB). The app runs the user's installed
// `claude`, so these are dropped.
const bundledExecutables = /^@anthropic-ai\/claude-agent-sdk-/

type Manifest = {
  name: string
  version?: string
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

export function installServerPackages(serverDir: string, platform: string, arch: string) {
  const manifest = readManifest(root)
  for (const name of serverExternalPackages) {
    if (!manifest.dependencies?.[name]) {
      throw new Error(`${name} is in lib/server-external-packages.ts but not in package.json dependencies.`)
    }
  }

  const staging = mkdtempSync(join(tmpdir(), 'busyboy-server-packages-'))
  try {
    // A separate project outside the repository, so the install cannot change
    // the repository's own node_modules or install state.
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      copyFileSync(join(root, file), join(staging, file))
    }
    execFileSync(
      'pnpm',
      ['install', '--frozen-lockfile', '--prod', '--config.node-linker=hoisted', '--prefer-offline', '--reporter=silent'],
      { cwd: staging, stdio: 'inherit', shell: process.platform === 'win32' },
    )
    const installed = join(staging, 'node_modules')
    for (const name of listPackages(installed)) {
      if (bundledExecutables.test(name)) rmSync(join(installed, name), { recursive: true, force: true })
    }

    const target = join(serverDir, 'node_modules')
    for (const name of dependencyClosure(installed, serverExternalPackages)) {
      const from = join(installed, name)
      const to = join(target, name)
      pruneForeignPrebuilds(from, platform, arch)
      if (pathExists(to)) {
        if ((serverExternalPackages as readonly string[]).includes(name)) {
          // Replace whatever tracing put there with the whole package.
          rmSync(to, { recursive: true, force: true })
        } else if (readManifest(to).version === readManifest(from).version) {
          continue
        } else {
          throw new Error(`${name} ${readManifest(from).version} conflicts with ${readManifest(to).version} in the server.`)
        }
      }
      cpSync(from, to, { recursive: true })
      makeSpawnHelperExecutable(to, platform, arch)
    }
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
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
