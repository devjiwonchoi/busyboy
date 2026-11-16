import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_IMAGE_BYTES, MAX_IMAGE_TEXT } from '@/lib/companion-limits'
import { dataFolder, readSettings, updateSettings } from './config'

// BusyBoy's companions: the face and voice of the Director, the agent the user chats with. The user picks
// one in setup; its voice is appended to the Director's instructions, so it
// must stay the same for a given companion (no dynamic values) to keep the
// provider's prompt cache warm.

export type Companion = {
  id: string
  name: string
  animal: string
  /** Emoji-level art until real artwork exists. */
  emoji: string
  /**
   * Circle behind the emoji. A full class string so Tailwind can see it.
   * The colors follow the character picker: a dark cat, a cream hamster,
   * a pink seal, a yellow elephant, a lilac squirrel.
   */
  tone: string
  /** How this character speaks, shown next to the name in settings. */
  speech: string
  /** One line kept with the character. */
  personality: string
  /** How the Director talks. Appended to its instructions. */
  voice: string
  /** The first message on the main screen, in the companion's voice. */
  greeting: string
}

/**
 * The Director roster. The first character is the one setup offers until the
 * user picks another. Names are the English forms of the roster in the picker.
 */
export const COMPANIONS: Companion[] = [
  {
    id: 'jota',
    name: 'Jota',
    animal: 'cat',
    emoji: '🐱',
    tone: 'bg-zinc-800 text-zinc-50',
    speech: 'Steady · precise',
    personality: 'Careful and thorough. Checks twice, ships once.',
    voice: 'Speak calmly and precisely in short sentences. Point out risks before they bite, without drama.',
    greeting: "Jota here. I'll keep an eye on the details. What should we work on?",
  },
  {
    id: 'rippu',
    name: 'Rippu',
    animal: 'hamster',
    emoji: '🐹',
    tone: 'bg-amber-100 text-amber-950',
    speech: 'Bright · upbeat',
    personality: 'Playful and upbeat. Makes long tasks feel short.',
    voice: 'Speak warmly and cheerfully, with the occasional light joke. Keep it brief and never let the fun hide the facts.',
    greeting: "Hi, I'm Rippu. Toss me a task and let's get moving.",
  },
  {
    id: 'ming',
    name: 'Ming',
    animal: 'seal',
    emoji: '🦭',
    tone: 'bg-pink-200 text-pink-950',
    speech: 'Gentle · thoughtful',
    personality: 'Thoughtful and patient. Explains the why, not just the what.',
    voice: 'Speak in a measured, thoughtful way. Briefly explain the reasoning behind a plan when it helps the user decide.',
    greeting: "Ming here. Tell me what you're building, and we'll think it through together.",
  },
  {
    id: 'yam',
    name: 'Yam',
    animal: 'elephant',
    emoji: '🐘',
    tone: 'bg-yellow-300 text-yellow-950',
    speech: 'Formal · encouraging',
    personality: 'Gentle and encouraging. Celebrates every small win.',
    voice: 'Be gentle and encouraging. Acknowledge progress, stay positive about setbacks, and keep replies short.',
    greeting: "Hello, I'm Yam. Whatever you're working on, we'll get there together.",
  },
  {
    id: 'peroming',
    name: 'Peroming',
    animal: 'squirrel',
    emoji: '🐿️',
    tone: 'bg-violet-200 text-violet-950',
    speech: 'Direct · quick',
    personality: 'Quick and decisive. Gets straight to work.',
    voice: 'Be brisk and action-first. Lead with what you are doing next and skip pleasantries.',
    greeting: "Peroming, ready to go. What's first?",
  },
]

/** The character setup selects until the user picks another. */
export const DEFAULT_COMPANION_ID = COMPANIONS[0].id

export function findCompanion(id: string | null | undefined) {
  return COMPANIONS.find((companion) => companion.id === id)
}

/**
 * Appended to the Director's instructions: the companion's voice, and what to do
 * when a task needs a project and none fits (setup lets the user start without one).
 */
export function companionInstructions(companion: Companion | undefined) {
  const lines = [
    'When a request needs a project folder and the user has none, or none that fits, ask the user to add the project folder first; do not guess a path.',
  ]
  if (companion) {
    lines.unshift(`You are ${companion.name}, the user's director in BusyBoy, a small ${companion.animal}. ${companion.voice}`)
  }
  return lines.join('\n')
}

/** The companion the user chose, if any. */
export async function currentCompanion() {
  return findCompanion((await readSettings()).companion)
}

/** Who the Director appears as: the chosen companion with the user's picture, or BusyBoy itself before one is chosen. */
export async function directorPersona(): Promise<{ name: string; mark?: string; imageUrl?: string; tone?: string }> {
  const [companion, imageUrl] = await Promise.all([currentCompanion(), companionImageUrl()])
  return companion ? { name: companion.name, mark: companion.emoji, imageUrl, tone: companion.tone } : { name: 'BusyBoy' }
}

export async function chooseCompanion(id: string) {
  if (!findCompanion(id)) throw new Error('Unknown companion.')
  await updateSettings((settings) => {
    settings.companion = id
  })
}

// ---- Custom picture ---------------------------------------------------------

const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}
const CONTENT_TYPES = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([type, extension]) => [extension, type]))

const IMAGE_PREFIX = 'app-companion-image.'

/**
 * The extension of a picture file BusyBoy created, or undefined. The name in
 * settings is checked against the names BusyBoy writes, so an edited settings
 * file can never point reads or deletes at another file in the data folder.
 */
function imageExtension(fileName: string | null) {
  if (!fileName?.startsWith(IMAGE_PREFIX)) return undefined
  const extension = fileName.slice(IMAGE_PREFIX.length)
  return extension in CONTENT_TYPES ? extension : undefined
}

export class CompanionImageError extends Error {}

const UNSUPPORTED_IMAGE = 'Choose a PNG, JPEG, WebP, or GIF picture.'

function startsWith(bytes: Uint8Array, signature: number[], offset = 0) {
  return signature.every((byte, index) => bytes[offset + index] === byte)
}

function hasSignature(bytes: Uint8Array, extension: string) {
  switch (extension) {
    case 'png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'jpg':
      return startsWith(bytes, [0xff, 0xd8, 0xff])
    case 'gif':
      return startsWith(bytes, [0x47, 0x49, 0x46, 0x38])
    case 'webp':
      return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
    default:
      return false
  }
}

/** Saves the picture into the data folder as `app-companion-image.<ext>`, replacing an earlier one. */
export async function saveCompanionImage(file: File) {
  const extension = IMAGE_TYPES[file.type]
  if (!extension) throw new CompanionImageError(UNSUPPORTED_IMAGE)
  if (file.size > MAX_IMAGE_BYTES) throw new CompanionImageError(`Choose a picture under ${MAX_IMAGE_TEXT}.`)
  const bytes = new Uint8Array(await file.arrayBuffer())
  // The declared type comes from the browser; the file's own signature must agree.
  if (!hasSignature(bytes, extension)) throw new CompanionImageError(UNSUPPORTED_IMAGE)
  const folder = await dataFolder()
  const fileName = `${IMAGE_PREFIX}${extension}`
  await updateSettings(async (settings) => {
    // Inside the settings queue, so two uploads never race on the same file.
    await mkdir(folder, { recursive: true })
    const temporary = join(folder, `${fileName}.${process.pid}.tmp`)
    const handle = await open(temporary, 'w')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, join(folder, fileName))
    const previous = settings.companionImage
    if (previous !== fileName && imageExtension(previous)) await rm(join(folder, previous!), { force: true })
    settings.companionImage = fileName
  })
}

export async function removeCompanionImage() {
  const folder = await dataFolder()
  await updateSettings(async (settings) => {
    if (imageExtension(settings.companionImage)) await rm(join(folder, settings.companionImage!), { force: true })
    settings.companionImage = null
  })
}

/** The saved picture and its content type, or undefined. */
export async function readCompanionImage() {
  const { companionImage } = await readSettings()
  const extension = imageExtension(companionImage)
  if (!extension) return undefined
  try {
    const bytes = await readFile(join(await dataFolder(), companionImage!))
    return { bytes, contentType: CONTENT_TYPES[extension] }
  } catch {
    return undefined
  }
}

/** Where the page loads the picture from, or undefined. The version changes with the file, so a new picture is never served from cache. */
export async function companionImageUrl() {
  const { companionImage } = await readSettings()
  if (!imageExtension(companionImage)) return undefined
  try {
    const { mtimeMs } = await stat(join(await dataFolder(), companionImage!))
    return `${COMPANION_IMAGE_ROUTE}?v=${Math.round(mtimeMs)}`
  } catch {
    return undefined
  }
}

export const COMPANION_IMAGE_ROUTE = '/api/companion-image'
