import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { attachmentProblem, imageMediaType, type AttachmentInput, type ImageMediaType } from '@/lib/chat-attachments'
import type { TurnImage, UserTurn } from './runner/user-turn'

export class AttachmentError extends Error {}

const ATTACHMENTS_FOLDER = 'attachments'

function safeName(name: string) {
  const base = basename(name).replace(/[^\w.\- ]+/g, '').trim().slice(0, 80)
  return base && base !== '.' && base !== '..' ? base : 'file'
}

function bytesOf(data: string) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return null
  return Buffer.from(data, 'base64')
}

/** PNG, JPEG, GIF, and WebP, told by their first bytes rather than the claimed type. */
function matchesImage(bytes: Buffer, mediaType: ImageMediaType) {
  if (mediaType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (mediaType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mediaType === 'image/gif') return bytes.subarray(0, 4).toString('ascii') === 'GIF8'
  return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
}

/**
 * Writes attachments under `folder/attachments` and returns the turn to send.
 * Images stay bytes the harness can hand to the model; other files are only a path.
 */
export async function attachmentsTurn({ folder, text, attachments }: { folder: string; text: string; attachments: AttachmentInput[] }): Promise<UserTurn> {
  const images: TurnImage[] = []
  const notes: string[] = []
  let total = 0
  if (!Array.isArray(attachments)) throw new AttachmentError('Attachments must be a list of files.')
  for (const [index, attachment] of attachments.entries()) {
    if (!attachment || typeof attachment.name !== 'string' || typeof attachment.mediaType !== 'string' || typeof attachment.data !== 'string') {
      throw new AttachmentError('An attachment is missing its name or contents.')
    }
    const bytes = bytesOf(attachment.data)
    if (!bytes) throw new AttachmentError(`${attachment.name || 'An attachment'} could not be read.`)
    const problem = attachmentProblem({
      name: attachment.name,
      mediaType: attachment.mediaType,
      bytes: bytes.length,
      already: index,
      totalBytes: total,
    })
    if (problem) throw new AttachmentError(problem)
    total += bytes.length
    const image = imageMediaType(attachment.name, attachment.mediaType)
    if (image && !matchesImage(bytes, image)) {
      throw new AttachmentError(`${attachment.name || 'That image'} could not be read. Use a PNG, JPEG, GIF, or WebP image.`)
    }
    const name = safeName(attachment.name)
    const path = join(folder, ATTACHMENTS_FOLDER, `${randomBytes(4).toString('hex')}-${name}`)
    await mkdir(join(folder, ATTACHMENTS_FOLDER), { recursive: true })
    await writeFile(path, bytes)
    if (image) images.push({ name, mediaType: image, data: attachment.data, path })
    else notes.push(`Attached file: ${path}`)
  }
  return { text: text.trim(), note: notes.join('\n'), images }
}
