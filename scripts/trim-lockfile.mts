// Rewrites a pnpm-lock.yaml so its root importer lists only `keep`.
// The package snapshots stay, so the kept packages still install at the locked versions.
// The caller updates package.json to the same set; `pnpm install --frozen-lockfile` then
// installs that set instead of the whole app.
export function trimLockfile(lockText: string, keep: ReadonlySet<string>): string {
  const newline = lockText.endsWith('\r\n') ? '\r\n' : '\n'
  const lines = lockText.split(/\r?\n/)
  const out: string[] = []
  let index = 0

  while (index < lines.length && lines[index] !== 'importers:') out.push(lines[index++]!)
  if (index >= lines.length) throw new Error('pnpm-lock.yaml has no importers section.')
  out.push(lines[index++]!)

  while (index < lines.length && lines[index] !== '  .:') out.push(lines[index++]!)
  if (index >= lines.length) throw new Error('pnpm-lock.yaml has no root importer.')
  out.push(lines[index++]!)

  const sections = new Set(['    dependencies:', '    devDependencies:', '    optionalDependencies:'])
  while (index < lines.length && lines[index] !== 'packages:') {
    const header = lines[index]!
    if (!sections.has(header)) {
      out.push(header)
      index++
      continue
    }
    index++
    const kept: string[] = []
    while (index < lines.length && lines[index]!.startsWith('      ')) {
      const nameLine = lines[index]!
      if (!nameLine.startsWith('      ') || nameLine.startsWith('        ')) {
        throw new Error(`Unexpected line in pnpm-lock.yaml importers: ${nameLine}`)
      }
      const block = [nameLine]
      index++
      while (index < lines.length && lines[index]!.startsWith('        ')) block.push(lines[index++]!)
      const name = unquote(nameLine.trim().replace(/:$/, ''))
      if (keep.has(name)) kept.push(...block)
    }
    if (kept.length > 0) {
      out.push(header)
      out.push(...kept)
    }
  }

  while (index < lines.length) out.push(lines[index++]!)
  return out.join(newline)
}

function unquote(value: string) {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'")
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1)
  return value
}
