// tar -h drops pnpm's sibling packages, and Node then cannot load them from the standalone tree alone.
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

// Turbopack's external import, including `shiki-<hash>/engine/javascript`.
const HASHED_SPECIFIER = /["']((?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+-[0-9a-f]{8,}(?:\/[A-Za-z0-9._@+/-]+)?)["']/g
const SWC_REQUIRE = /require\(["'](@swc\/helpers\/[^"']+)["']\)/g

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function hashedSpecifiers(serverDir: string): string[] {
  const found = new Set<string>()
  const stack = [join(serverDir, '.next', 'server')]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (!existsSync(current)) continue
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        const text = readFileSync(path, 'utf8')
        for (const match of text.matchAll(HASHED_SPECIFIER)) found.add(match[1])
      }
    }
  }
  return [...found]
}

function swcRequires(nextDist: string): string[] {
  const found = new Set<string>()
  const stack = [join(nextDist, 'server'), join(nextDist, 'shared')]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (!existsSync(current)) continue
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(path)
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        for (const match of readFileSync(path, 'utf8').matchAll(SWC_REQUIRE)) found.add(match[1])
      }
    }
  }
  return [...found]
}

export function assertServerResolves(standaloneDir: string) {
  const root = realpathSync(standaloneDir)
  const failures: string[] = []
  const fromServer = join(root, '.next', 'server', 'chunks', 'resolution-check.js')
  const serverRequire = createRequire(fromServer)

  const nextDist = join(root, 'node_modules', 'next', 'dist')
  const constants = join(nextDist, 'shared', 'lib', 'constants.js')
  if (!existsSync(constants)) {
    failures.push('The standalone server has no next/dist/shared/lib/constants.js.')
  } else {
    const fromNext = createRequire(realpathSync(constants))
    for (const request of swcRequires(nextDist)) {
      try {
        const resolved = realpathSync(fromNext.resolve(request))
        if (!inside(root, resolved)) {
          failures.push(`next cannot resolve ${request} from this server (found ${resolved} outside it).`)
        }
      } catch (error) {
        failures.push(
          `next cannot resolve ${request} (${error instanceof Error ? error.message : String(error)}). pnpm's sibling packages were not kept with next.`,
        )
      }
    }
  }

  for (const specifier of hashedSpecifiers(root)) {
    try {
      const resolved = realpathSync(serverRequire.resolve(specifier))
      if (!inside(root, resolved)) {
        failures.push(`Turbopack external ${specifier} resolved outside the server (${resolved}).`)
      }
    } catch (error) {
      failures.push(
        `The server cannot resolve Turbopack external ${specifier} from .next/node_modules (${error instanceof Error ? error.message : String(error)}).`,
      )
    }
  }

  if (failures.length > 0) {
    throw new Error(`The standalone server cannot resolve its modules:\n${[...new Set(failures)].join('\n')}`)
  }
}
