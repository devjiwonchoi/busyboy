// Packs the shared Next and Electron build for the release workflow.
//
//   node scripts/pack-desktop-bundle.mts
//
// macOS receives pnpm's symlinks, which the standalone server loads. Windows
// cannot create those symlinks (tar reports the target is missing), so it
// receives a second archive with every link stored as a real file.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const root = join(import.meta.dirname, '..')
const roots = [join(root, '.next', 'standalone'), join(root, 'dist-electron')]

if (!existsSync(join(roots[0], 'server.js'))) {
  throw new Error('No .next/standalone/server.js. Run `next build` first.')
}
if (!existsSync(join(roots[1], 'main.cjs'))) {
  throw new Error('No dist-electron/main.cjs. Run `pnpm build:electron` first.')
}

function inside(candidate: string, containers: readonly string[]): boolean {
  return containers.some((container) => {
    const rel = relative(container, candidate)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
}

// A link into the build machine's node_modules works on that runner and
// nowhere else. tar -h would also copy the target into the Windows archive.
const realRoots = roots.map((dir) => realpathSync(dir))
const leaks: string[] = []
for (const dir of roots) {
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        const link = readlinkSync(path)
        const target = isAbsolute(link) ? link : resolve(dirname(path), link)
        let real = target
        try {
          if (existsSync(target)) real = realpathSync(target)
        } catch {
          real = target
        }
        if (!existsSync(target) || !inside(target, realRoots) || !inside(real, realRoots)) {
          leaks.push(`${relative(root, path)} -> ${link}`)
        }
      } else if (entry.isDirectory()) {
        stack.push(path)
      }
    }
  }
}
if (leaks.length > 0) {
  throw new Error(`The app bundle has symlinks that leave the standalone server:\n${leaks.join('\n')}`)
}

function listSymlinks(archive: string): string[] {
  const listing = execFileSync('tar', ['-tvf', archive], { cwd: root, encoding: 'utf8' })
  return listing.split('\n').filter((line) => line.startsWith('l'))
}

execFileSync('tar', ['--format=posix', '-cf', 'desktop-bundle.tar', '.next/standalone', 'dist-electron'], {
  cwd: root,
  stdio: 'inherit',
})
if (listSymlinks('desktop-bundle.tar').length < 1) {
  throw new Error('The app bundle has no symlinks. The standalone server would not start.')
}

execFileSync('tar', ['--format=posix', '-h', '--hard-dereference', '-cf', 'desktop-bundle-windows.tar', '.next/standalone', 'dist-electron'], {
  cwd: root,
  stdio: 'inherit',
})
const windowsLinks = listSymlinks('desktop-bundle-windows.tar')
if (windowsLinks.length > 0) {
  throw new Error(`The Windows app bundle still contains symlinks:\n${windowsLinks.join('\n')}`)
}

const macBytes = statSync(join(root, 'desktop-bundle.tar')).size
const windowsBytes = statSync(join(root, 'desktop-bundle-windows.tar')).size
console.log(`[pack-desktop-bundle] macOS archive ${macBytes} bytes, Windows archive ${windowsBytes} bytes`)
