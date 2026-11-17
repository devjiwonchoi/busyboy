// These packages load native files by computed paths, which Next's file tracing misses.
// node-pty loads build/Release ahead of the host prebuild, and codesign rejects the other platforms' binaries.
import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { serverExternalPackages } from '../src/lib/server-external-packages.ts'
import { trimLockfile } from './trim-lockfile.mts'

const root = join(import.meta.dirname, '..')

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

function topLevelName(nodeModules: string, packageDir: string): string {
  const parts = relative(nodeModules, packageDir).split(sep)
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
}

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

function pruneForeignPrebuilds(packageDir: string, platform: string, arch: string) {
  const prebuilds = join(packageDir, 'prebuilds')
  if (!existsSync(prebuilds)) return
  for (const target of readdirSync(prebuilds)) {
    if (target !== `${platform}-${arch}`) rmSync(join(prebuilds, target), { recursive: true, force: true })
  }
}

// node-pty loads build/Release ahead of the host prebuild, and codesign will not sign the Windows conpty binaries.
function pruneNodePtyLayout(packageDir: string, platform: string, arch: string) {
  pruneForeignPrebuilds(packageDir, platform, arch)
  rmSync(join(packageDir, 'third_party'), { recursive: true, force: true })
  if (existsSync(join(packageDir, 'prebuilds', `${platform}-${arch}`))) {
    rmSync(join(packageDir, 'build'), { recursive: true, force: true })
  }
  makeSpawnHelperExecutable(packageDir, platform, arch)
}

function looksLikeNodePty(dir: string, entryName: string): boolean {
  if (entryName !== 'node-pty' && !/^node-pty-[0-9a-f]+$/.test(entryName)) return false
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return existsSync(join(dir, 'prebuilds')) || existsSync(join(dir, 'third_party'))
  try {
    return (JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string }).name === 'node-pty'
  } catch {
    return false
  }
}

function pruneNodePtyPackages(serverDir: string, platform: string, arch: string) {
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
      if (looksLikeNodePty(path, entry.name)) {
        pruneNodePtyLayout(path, platform, arch)
        continue
      }
      stack.push(path)
    }
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

function lockedSharp(lockText: string): { specifier: string; version: string } | null {
  const withPeer = /^  sharp@(\d+\.\d+\.\d+)\([^)\n]+\):/m.exec(lockText)
  if (withPeer) return { specifier: withPeer[1], version: withPeer[1] + withPeer[0].slice(`  sharp@${withPeer[1]}`.length, -1) }
  const plain = /^  sharp@(\d+\.\d+\.\d+):/m.exec(lockText)
  return plain ? { specifier: plain[1], version: plain[1] } : null
}

function quoteYaml(name: string) {
  return /[^A-Za-z0-9_-]/.test(name) ? `'${name.replaceAll("'", "''")}'` : name
}

function addLockfileDependency(lockText: string, name: string, specifier: string, version: string) {
  const newline = lockText.includes('\r\n') ? '\r\n' : '\n'
  const header = `    dependencies:${newline}`
  const entry = `      ${quoteYaml(name)}:${newline}        specifier: ${specifier}${newline}        version: ${version}${newline}`
  const at = lockText.indexOf(header)
  if (at === -1) throw new Error('The trimmed lockfile has no dependencies section to add sharp to.')
  return lockText.slice(0, at + header.length) + entry + lockText.slice(at + header.length)
}

// A standalone output built on another machine contains that machine's sharp binary, and loading it crashes the server.
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
          if (keep.has(child.name) || !child.name.startsWith('sharp-')) continue
          if (!child.isDirectory() && !child.isSymbolicLink()) continue
          rmSync(join(path, child.name), { recursive: true, force: true })
        }
      }
      stack.push(path)
    }
  }
}

// Package names that encode the platform they were built for. `arm` must not
// match inside `arm64`, so the arch is a whole token.
const PLATFORM_TOKEN = /(?:^|[^A-Za-z0-9])((?:aix|android|darwin|freebsd|linux|netbsd|openbsd|openharmony|sunos|win32)-(?:arm64|arm|ia32|loong64|mips64el|ppc64le|ppc64|riscv64|s390x|x64))(?=$|[^A-Za-z0-9])/g

function isForeignPlatformPackage(name: string, platform: string, arch: string): boolean {
  const host = `${platform}-${arch}`
  const tokens = name.match(PLATFORM_TOKEN)
  if (!tokens) return false
  return !tokens.some((token) => token.replace(/^[^A-Za-z0-9]+/, '') === host)
}

function packageNameAt(dir: string): string {
  const parent = basename(dirname(dir))
  const name = basename(dir)
  return parent.startsWith('@') ? `${parent}/${name}` : name
}

/** True when the name contains a `platform-arch` token such as `darwin-arm64`. */
function mentionsPlatform(name: string): boolean {
  return name.match(PLATFORM_TOKEN) !== null
}

// Turbopack's hashed Claude SDK alias is not the bundled claude executable and has to stay.
function removeForeignNativePackages(serverDir: string, platform: string, arch: string) {
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
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const path = join(dir, entry.name)
      const name = packageNameAt(path)
      const drop =
        (name.startsWith('@anthropic-ai/claude-agent-sdk-') && mentionsPlatform(name)) ||
        ((name.startsWith('@next/swc-') || name.startsWith('@esbuild/')) && isForeignPlatformPackage(name, platform, arch))
      if (drop) {
        rmSync(path, { recursive: true, force: true })
        continue
      }
      if (entry.isDirectory()) stack.push(path)
    }
  }
}

type BinaryKind = 'elf' | 'macho' | 'pe'

function nativeBinaryKind(path: string): BinaryKind | null {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const header = Buffer.alloc(4)
    if (readSync(fd, header, 0, 4, 0) < 4) return null
    if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) return 'elf'
    const big = header.readUInt32BE(0)
    const little = header.readUInt32LE(0)
    if (big === 0xfeedface || big === 0xfeedfacf || little === 0xfeedface || little === 0xfeedfacf) return 'macho'
    if (header[0] !== 0x4d || header[1] !== 0x5a) return null
    const offsetBuf = Buffer.alloc(4)
    if (readSync(fd, offsetBuf, 0, 4, 0x3c) < 4) return null
    const offset = offsetBuf.readUInt32LE(0)
    if (offset < 0x40 || offset > 1024) return null
    const signature = Buffer.alloc(4)
    if (readSync(fd, signature, 0, 4, offset) < 4) return null
    return signature.toString('latin1') === 'PE\0\0' ? 'pe' : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function hostBinaryKind(platform: string): BinaryKind {
  if (platform === 'win32') return 'pe'
  if (platform === 'darwin') return 'macho'
  return 'elf'
}

const BINARY_KIND_LABEL: Record<BinaryKind, string> = { elf: 'Linux', macho: 'macOS', pe: 'Windows' }

/** Fails the build while the foreign file is still a path, rather than a codesign error. */
function assertHostBinaries(serverDir: string, platform: string) {
  const host = hostBinaryKind(platform)
  const foreign: string[] = []
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
      const path = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile()) {
        const kind = nativeBinaryKind(path)
        if (kind && kind !== host) foreign.push(`${path} (${BINARY_KIND_LABEL[kind]})`)
      }
    }
  }
  if (foreign.length > 0) {
    throw new Error(`The server still contains binaries for another operating system:\n${foreign.join('\n')}`)
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
      if (name === 'node-pty') pruneNodePtyLayout(from, platform, arch)
      else pruneForeignPrebuilds(from, platform, arch)
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
  removeForeignNativePackages(serverDir, platform, arch)
  // Traced copies and the `.pnpm` store still carry the build machine's node-pty.
  pruneNodePtyPackages(serverDir, platform, arch)
  pointAliasesAtInstalledPackages(serverDir, platform)
  assertHostBinaries(serverDir, platform)
}

// Next loads .next/node_modules/<name>-<hash>, which lacks the native binaries. Windows has no symlinks there.
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

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
