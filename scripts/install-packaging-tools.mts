import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { trimLockfile } from './trim-lockfile.mts'

const root = join(import.meta.dirname, '..')
const keep = ['electron', 'electron-builder'] as const

const packagePath = join(root, 'package.json')
const lockPath = join(root, 'pnpm-lock.yaml')
const packageBackup = readFileSync(packagePath)
const lockBackup = readFileSync(lockPath)

try {
  const manifest = JSON.parse(packageBackup.toString('utf8')) as {
    devDependencies?: Record<string, string>
    dependencies?: Record<string, string>
  }
  const devDependencies: Record<string, string> = {}
  for (const name of keep) {
    const spec = manifest.devDependencies?.[name]
    if (!spec) throw new Error(`${name} is not a devDependency, so the packaging tools cannot be installed from the lockfile.`)
    devDependencies[name] = spec
  }
  const trimmed = { ...manifest, devDependencies }
  delete trimmed.dependencies
  writeFileSync(packagePath, `${JSON.stringify(trimmed, null, 2)}\n`)
  writeFileSync(lockPath, trimLockfile(lockBackup.toString('utf8'), new Set(keep)))
  execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--reporter=append-only'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
} finally {
  writeFileSync(packagePath, packageBackup)
  writeFileSync(lockPath, lockBackup)
}
