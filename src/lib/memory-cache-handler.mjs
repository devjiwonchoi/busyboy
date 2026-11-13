// In-memory replacement for Next's filesystem cache handler (ISR, route
// handler responses, fetch cache, optimized images). The default handler
// writes under `.next` next to the server, which in the desktop app is inside
// the signed app bundle (or a read-only Program Files folder). BusyBoy is a
// single-user local app whose cached data is rebuilt from local files, so
// entries live only as long as the server process.
const MAX_ENTRIES = 1000

const entries = new Map()
// When each tag was last revalidated. An entry carrying a tag revalidated
// after it was stored is stale, which covers revalidateTag and, through the
// implicit path tags, revalidatePath.
const revalidatedAt = new Map()

function remember(key, entry) {
  entries.delete(key)
  entries.set(key, entry)
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value)
}

/** Pages and route handlers carry their tags in a response header, not in ctx.tags. */
function headerTags(value) {
  const header = value?.headers?.['x-next-cache-tags']
  return typeof header === 'string' ? header.split(',').filter(Boolean) : []
}

function isStale(entry, extraTags) {
  for (const tag of [...entry.tags, ...extraTags]) {
    const at = revalidatedAt.get(tag)
    if (at !== undefined && at >= entry.lastModified) return true
  }
  return false
}

export default class MemoryCacheHandler {
  async get(key, ctx) {
    const entry = entries.get(key)
    if (!entry) return null
    if (isStale(entry, [...(ctx?.tags ?? []), ...(ctx?.softTags ?? [])])) {
      entries.delete(key)
      return null
    }
    remember(key, entry)
    return entry
  }

  async set(key, data, ctx) {
    if (data === null) {
      entries.delete(key)
      return
    }
    const tags = [...new Set([...(ctx?.tags ?? []), ...headerTags(data)])]
    remember(key, { value: data, lastModified: Date.now(), tags })
  }

  async revalidateTag(tagOrTags) {
    const now = Date.now()
    for (const tag of [tagOrTags].flat()) revalidatedAt.set(tag, now)
  }

  resetRequestCache() {}
}
