import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  attachmentProblem,
  IMAGE_MEDIA_TYPES,
  imageMediaType,
  MAX_IMAGE_BYTES,
  type AttachmentInput,
  type ImageMediaType,
  type MessageImage,
} from "@/lib/chat-attachments";

import type { TurnImage, UserTurn } from "./runner/user-turn";

export class AttachmentError extends Error {}

const ATTACHMENTS_FOLDER = "attachments";

function safeName(name: string) {
  const base = basename(name)
    .replace(/[^\w.\- ]+/g, "")
    .trim()
    .slice(0, 80);
  return base && base !== "." && base !== ".." ? base : "file";
}

function bytesOf(data: string) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return null;
  return Buffer.from(data, "base64");
}

function matchesImage(bytes: Buffer, mediaType: ImageMediaType) {
  if (mediaType === "image/png")
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mediaType === "image/jpeg")
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mediaType === "image/gif") return bytes.subarray(0, 4).toString("ascii") === "GIF8";
  return (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

export async function attachmentsTurn({
  folder,
  text,
  attachments,
}: {
  folder: string;
  text: string;
  attachments: AttachmentInput[];
}): Promise<UserTurn> {
  const images: TurnImage[] = [];
  const notes: string[] = [];
  let total = 0;
  if (!Array.isArray(attachments))
    throw new AttachmentError("Attachments must be a list of files.");
  for (const [index, attachment] of attachments.entries()) {
    if (
      !attachment ||
      typeof attachment.name !== "string" ||
      typeof attachment.mediaType !== "string" ||
      typeof attachment.data !== "string"
    ) {
      throw new AttachmentError("An attachment is missing its name or contents.");
    }
    const bytes = bytesOf(attachment.data);
    if (!bytes)
      throw new AttachmentError(`${attachment.name || "An attachment"} could not be read.`);
    const problem = attachmentProblem({
      name: attachment.name,
      mediaType: attachment.mediaType,
      bytes: bytes.length,
      already: index,
      totalBytes: total,
    });
    if (problem) throw new AttachmentError(problem);
    total += bytes.length;
    const image = imageMediaType(attachment.name, attachment.mediaType);
    if (image && !matchesImage(bytes, image)) {
      throw new AttachmentError(
        `${attachment.name || "That image"} could not be read. Use a PNG, JPEG, GIF, or WebP image.`,
      );
    }
    const name = safeName(attachment.name);
    const path = join(folder, ATTACHMENTS_FOLDER, `${randomBytes(4).toString("hex")}-${name}`);
    await mkdir(join(folder, ATTACHMENTS_FOLDER), { recursive: true });
    await writeFile(path, bytes);
    if (image) images.push({ name, mediaType: image, data: attachment.data, path });
    else notes.push(`Attached file: ${path}`);
  }
  return { text: text.trim(), note: notes.join("\n"), images };
}

export function messageImages(turn: UserTurn, task?: string): MessageImage[] | undefined {
  if (turn.images.length === 0) return undefined;
  return turn.images.map((image) => ({
    name: image.name,
    file: basename(image.path),
    ...(task ? { task } : {}),
  }));
}

const NO_FOLLOW: number | undefined = constants.O_NOFOLLOW;

const SAVED_NAME = /^[0-9a-f]{8}-[\w.\- ]{1,80}$/;

export async function readSavedImage(
  folder: string,
  file: string,
): Promise<{ bytes: Buffer; mediaType: ImageMediaType; path: string } | null> {
  if (!SAVED_NAME.test(file)) return null;
  const attachments = join(/*turbopackIgnore: true*/ folder, ATTACHMENTS_FOLDER);
  const path = join(/*turbopackIgnore: true*/ attachments, file);
  try {
    if (!(await lstat(/*turbopackIgnore: true*/ attachments)).isDirectory()) return null;
    if (NO_FOLLOW === undefined && !(await lstat(/*turbopackIgnore: true*/ path)).isFile()) return null;
    const handle = await open(/*turbopackIgnore: true*/ path, constants.O_RDONLY | (NO_FOLLOW ?? 0))
    try {
      const stats = await handle.stat()
      if (!stats.isFile() || stats.size > MAX_IMAGE_BYTES) return null
      const bytes = await handle.readFile()
      const mediaType = IMAGE_MEDIA_TYPES.find((type) => matchesImage(bytes, type))
      return mediaType ? { bytes, mediaType, path } : null
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}
