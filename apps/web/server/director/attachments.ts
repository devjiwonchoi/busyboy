import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  attachmentProblem,
  IMAGE_MEDIA_TYPES,
  imageMediaType,
  type ImageMediaType,
  type MessageAttachment,
} from "@/lib/chat-attachments";

import type { TurnImage, UserTurn } from "../runner/user-turn";

export class AttachmentError extends Error {}

const ATTACHMENTS_FOLDER = "attachments";
const SAVED_NAME = /^[0-9a-f]{8}-[\w.\- ]{1,80}$/;
const MAX_SERVED_BYTES = 4 * 1024 * 1024;

function safeName(name: string) {
  const base = basename(name)
    .replace(/[^\w.\- ]+/g, "")
    .trim()
    .slice(0, 80);
  return base && base !== "." && base !== ".." ? base : "file";
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

export async function saveAttachments(
  folder: string,
  text: string,
  files: File[],
): Promise<{ turn: UserTurn; saved: MessageAttachment[] }> {
  const checked: { name: string; bytes: Buffer; image: ImageMediaType | null }[] = [];
  let total = 0;
  for (const [index, file] of files.entries()) {
    const problem = attachmentProblem({
      name: file.name,
      mediaType: file.type,
      bytes: file.size,
      already: index,
      totalBytes: total,
    });
    if (problem) throw new AttachmentError(problem);
    total += file.size;
    const bytes = Buffer.from(await file.arrayBuffer());
    const image = imageMediaType(file.name, file.type);
    if (image && !matchesImage(bytes, image)) {
      throw new AttachmentError(
        `${file.name || "That image"} could not be read. Use a PNG, JPEG, GIF, or WebP image.`,
      );
    }
    checked.push({ name: file.name, bytes, image });
  }

  const turn: UserTurn = { text, files: [], images: [] };
  const saved: MessageAttachment[] = [];
  if (checked.length === 0) return { turn, saved };
  const directory = join(folder, ATTACHMENTS_FOLDER);
  await mkdir(directory, { recursive: true });
  for (const { name: original, bytes, image } of checked) {
    const name = safeName(original);
    const file = `${randomBytes(4).toString("hex")}-${name}`;
    const path = join(directory, file);
    await writeFile(path, bytes);
    saved.push({ name, file, image: image !== null });
    if (image) {
      const turnImage: TurnImage = {
        name,
        mediaType: image,
        data: bytes.toString("base64"),
        path,
      };
      turn.images.push(turnImage);
    } else turn.files.push(path);
  }
  return { turn, saved };
}

const NO_FOLLOW: number | undefined = constants.O_NOFOLLOW;

export async function readSavedImage(
  folder: string,
  file: string,
): Promise<{ bytes: Buffer; mediaType: ImageMediaType } | null> {
  if (!SAVED_NAME.test(file)) return null;
  const directory = join(/*turbopackIgnore: true*/ folder, ATTACHMENTS_FOLDER);
  const path = join(/*turbopackIgnore: true*/ directory, file);
  try {
    if (!(await lstat(/*turbopackIgnore: true*/ directory)).isDirectory()) return null;
    if (NO_FOLLOW === undefined && !(await lstat(/*turbopackIgnore: true*/ path)).isFile())
      return null;
    const handle = await open(
      /*turbopackIgnore: true*/ path,
      constants.O_RDONLY | (NO_FOLLOW ?? 0),
    );
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > MAX_SERVED_BYTES) return null;
      const bytes = await handle.readFile();
      const mediaType = IMAGE_MEDIA_TYPES.find((type) => matchesImage(bytes, type));
      return mediaType ? { bytes, mediaType } : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
