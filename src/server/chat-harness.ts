import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { effortValues, harnessById } from './harness'
import type { ProviderId } from './runner/contract'

// One file per chat, next to that chat's transcript: the Director's is
// `<data>/director/harness.json`, a manager's is `<data>/managers/<id>/harness.json`.

export const HARNESS_FILE = 'harness.json'

const MODEL_LIMIT = 80

export type ChatHarness = {
  provider: ProviderId
  /** Left out when the chat uses the harness's own model. */
  model?: string
  /** Left out when the chat uses the harness's own effort. */
  effort?: string
}

function cleanModel(value: unknown) {
  if (typeof value !== 'string') return undefined
  const model = value.trim()
  if (!model || model.length > MODEL_LIMIT || /[\r\n\0]/.test(model)) return undefined
  return model
}

/** A stored choice, or null when the file is missing or not one. */
export function parseChatHarness(value: unknown): ChatHarness | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const harness = typeof record.provider === 'string' ? harnessById(record.provider) : undefined
  if (!harness) return null
  const model = cleanModel(record.model)
  const effort = typeof record.effort === 'string' ? record.effort : undefined
  const allowed = effortValues(harness.id)
  return {
    provider: harness.id,
    ...(model ? { model } : {}),
    ...(effort && allowed.includes(effort) ? { effort } : {}),
  }
}

export async function readChatHarness(folder: string): Promise<ChatHarness | null> {
  try {
    return parseChatHarness(JSON.parse(await readFile(join(folder, HARNESS_FILE), 'utf8')))
  } catch {
    return null
  }
}

/** Saves the choice. An empty model or effort is dropped, so the harness default applies. */
export async function writeChatHarness(folder: string, value: unknown): Promise<ChatHarness> {
  const choice = parseChatHarness(value)
  if (!choice) throw new Error('Unknown harness.')
  await mkdir(folder, { recursive: true })
  const file = join(folder, HARNESS_FILE)
  const temporary = `${file}.tmp`
  await writeFile(temporary, `${JSON.stringify(choice, null, 2)}\n`)
  await rename(temporary, file)
  return choice
}
