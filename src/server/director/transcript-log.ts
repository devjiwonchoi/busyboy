import { appendFile, mkdir, readdir, readFile, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** The file new transcript entries are appended to. */
export const TRANSCRIPT_FILE = 'transcript.jsonl'

/**
 * Closed segments are named `transcript.<n>.jsonl`, with `n` starting at 1.
 * The active file is rotated before an append that would push it past this
 * size, so each file stays near 20MB. One entry larger than the limit is
 * written whole and rotated away on the next append.
 */
export const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024

const SEGMENT_NAME = /^transcript\.(\d+)\.jsonl$/

/** Bytes already written to the active file, once known. Callers serialize appends. */
export type TranscriptCursor = { bytes?: number }

async function fileSize(file: string) {
  try {
    return (await stat(file)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

/**
 * The whole transcript, oldest closed segment first and the active file last,
 * so a later line with the same id still replaces an earlier one. Missing
 * files read as empty, the same as a chat that has not started.
 */
export async function readTranscript(folder: string) {
  let names: string[]
  try {
    names = await readdir(folder)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
  const segments = names
    .flatMap((name) => {
      const match = SEGMENT_NAME.exec(name)
      return match ? [{ name, index: Number(match[1]) }] : []
    })
    .sort((left, right) => left.index - right.index)
  let text = ''
  for (const segment of segments) {
    text = appendPart(text, await readFile(join(folder, segment.name), 'utf8').catch(() => ''))
  }
  return appendPart(text, await readFile(join(folder, TRANSCRIPT_FILE), 'utf8').catch(() => ''))
}

function appendPart(text: string, part: string) {
  if (!part) return text
  if (text && !text.endsWith('\n')) return `${text}\n${part}`
  return text + part
}

async function nextSegment(folder: string) {
  const names = await readdir(folder)
  const highest = names.reduce((max, name) => {
    const match = SEGMENT_NAME.exec(name)
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
  return highest + 1
}

/**
 * Appends one transcript line, including its trailing newline. Rotates the
 * active file first when the line would push it past the limit and the file
 * already holds something, then updates `cursor` so the next append need not
 * stat the file.
 */
export async function appendTranscriptLine(folder: string, line: string, cursor: TranscriptCursor) {
  await mkdir(folder, { recursive: true })
  const file = join(folder, TRANSCRIPT_FILE)
  if (cursor.bytes === undefined) cursor.bytes = await fileSize(file)
  const added = Buffer.byteLength(line)
  if (cursor.bytes > 0 && cursor.bytes + added > MAX_TRANSCRIPT_BYTES) {
    const archived = join(folder, `transcript.${await nextSegment(folder)}.jsonl`)
    try {
      await rename(file, archived)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    cursor.bytes = 0
  }
  await appendFile(file, line)
  cursor.bytes += added
}
