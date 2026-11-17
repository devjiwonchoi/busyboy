import { randomBytes } from 'node:crypto'
import { readSettings, updateSettings, type Settings } from './config'

// A room is a sidebar row for several projects at once. It is not a manager:
// each project can still have its own manager. The row shows those projects'
// letter avatars overlapping.

export type Room = { id: string; name: string; projects: string[] }

export class RoomError extends Error {}

const MAX_NAME_LENGTH = 40

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Rooms saved on the settings object. A bad entry is skipped. */
export function roomsFrom(settings: Settings): Room[] {
  const value = settings.rooms
  if (!Array.isArray(value)) return []
  const rooms: Room[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.name !== 'string' || !Array.isArray(entry.projects)) continue
    const projects = entry.projects.filter((project): project is string => typeof project === 'string' && project.trim().length > 0)
    if (projects.length < 2) continue
    rooms.push({ id: entry.id, name: entry.name, projects })
  }
  return rooms
}

export async function listRooms() {
  return roomsFrom(await readSettings())
}

/** Saves a room that names at least two projects. */
export async function createRoom(input: { name?: string; projects: string[] }) {
  const name = input.name?.trim() ?? ''
  if (!name || name.length > MAX_NAME_LENGTH) throw new RoomError(`Use 1 to ${MAX_NAME_LENGTH} characters for the name.`)
  const projects = [...new Set(input.projects.map((project) => project.trim()).filter(Boolean))]
  if (projects.length < 2) throw new RoomError('Choose at least two projects for a room.')
  const room: Room = { id: randomBytes(6).toString('hex'), name, projects }
  await updateSettings((settings) => {
    settings.rooms = [...roomsFrom(settings), room]
  })
  return room
}
