import { join } from 'node:path'
import { currentCompanion } from './companions'
import { dataFolder } from './config'
import { DIRECTOR_FOLDER, MANAGERS_FOLDER } from './director/chat'
import type { ChatEntry } from './director/chat'
import { readTranscript } from './director/transcript-log'
import { listManagersAt } from './managers'
import { readTasksAt } from './tasks'

export type PaletteChat = {
  /** Null for the Director. */
  id: string | null
  name: string
}

export type SearchHit = {
  kind: 'transcript' | 'task'
  /** Null when the hit is in the Director's chat. */
  chat: string | null
  chatName: string
  title: string
  snippet: string
  /** DOM id the chat scrolls to. */
  anchor: string
}

const HIT_LIMIT = 20

function snippet(text: string, query: string) {
  const flat = text.replace(/\s+/g, ' ').trim()
  const at = flat.toLowerCase().indexOf(query)
  const start = Math.max(0, at - 40)
  const cut = flat.slice(start, start + 140)
  return `${start > 0 ? '…' : ''}${cut}${start + 140 < flat.length ? '…' : ''}`
}

function entryText(entry: ChatEntry) {
  if (entry.kind === 'user' || entry.kind === 'director' || entry.kind === 'note') return typeof entry.text === 'string' ? entry.text : ''
  if (entry.kind === 'card') return `${entry.title} ${entry.taskTitle} ${entry.outcome}`
  return ''
}

function entryTitle(entry: ChatEntry, chatName: string) {
  if (entry.kind === 'user') return entry.to ? `To ${entry.to}` : 'You'
  if (entry.kind === 'note') return 'Note'
  if (entry.kind === 'card') return entry.title
  return chatName
}

async function transcriptHits(folder: string, chat: string | null, chatName: string, query: string) {
  const hits: SearchHit[] = []
  const text = await readTranscript(folder)
  for (const line of text.split('\n')) {
    if (!line) continue
    let entry: ChatEntry
    try {
      entry = JSON.parse(line) as ChatEntry
    } catch {
      continue
    }
    const body = entryText(entry)
    if (!body.toLowerCase().includes(query) || typeof entry.id !== 'string') continue
    hits.push({
      kind: 'transcript',
      chat,
      chatName,
      title: entryTitle(entry, chatName),
      snippet: snippet(body, query),
      anchor: `entry-${entry.id}`,
    })
    if (hits.length >= HIT_LIMIT) break
  }
  return hits
}

/**
 * Chats for the palette, and the transcript lines and task titles that match
 * `query`. An empty query returns the chats and no hits.
 */
export async function commandPalette(query: string): Promise<{ chats: PaletteChat[]; hits: SearchHit[] }> {
  const folder = await dataFolder()
  const [companion, managers, tasks] = await Promise.all([currentCompanion(), listManagersAt(folder), readTasksAt(folder)])
  const directorName = companion?.name ?? 'BusyBoy'
  const chats: PaletteChat[] = [
    { id: null, name: directorName },
    ...managers.map((manager) => ({ id: manager.id, name: manager.name })),
  ]
  const needle = query.trim().toLowerCase()
  if (!needle) return { chats, hits: [] }
  const listed = new Set(managers.map((manager) => manager.id))
  const nameOf = (chat: string | null) => chats.find((entry) => entry.id === chat)?.name ?? directorName
  const groups = await Promise.all([
    transcriptHits(join(folder, DIRECTOR_FOLDER), null, directorName, needle),
    ...managers.map((manager) =>
      transcriptHits(join(folder, MANAGERS_FOLDER, manager.id), manager.id, manager.name, needle),
    ),
  ])
  const hits = groups.flat()
  for (const task of tasks) {
    if (hits.length >= HIT_LIMIT) break
    if (typeof task.title !== 'string' || !task.title.toLowerCase().includes(needle)) continue
    const chat = task.chat && listed.has(task.chat) ? task.chat : null
    hits.push({
      kind: 'task',
      chat,
      chatName: nameOf(chat),
      title: task.title,
      snippet: task.project,
      anchor: `task-${task.id}`,
    })
  }
  return { chats, hits: hits.slice(0, HIT_LIMIT) }
}
