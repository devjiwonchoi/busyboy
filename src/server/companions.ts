import { randomInt } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { MAX_IMAGE_BYTES, MAX_IMAGE_TEXT } from "@/lib/companion-limits";

import { dataFolder, readSettings, updateSettings } from "./config";

// why: The voice is appended to the Director's instructions and stays free of per-turn values so the prompt cache holds.

export type Companion = {
  id: string;
  name: string;
  animal: string;
  emoji: string;
  // why: Full class strings so Tailwind can see them.
  tone: string;
  speech: string;
  personality: string;
  voice: string;
  greeting: string;
};

export const COMPANIONS: Companion[] = [
  {
    id: "jota",
    name: "Jota",
    animal: "cat",
    emoji: "🐱",
    tone: "bg-zinc-800 text-zinc-50",
    speech: "Steady · precise",
    personality: "Careful and thorough. Checks twice, ships once.",
    voice:
      "Speak calmly and precisely in short sentences. Point out risks before they bite, without drama.",
    greeting: "Jota here. I'll keep an eye on the details. What should we work on?",
  },
  {
    id: "rippu",
    name: "Rippu",
    animal: "hamster",
    emoji: "🐹",
    tone: "bg-amber-100 text-amber-950",
    speech: "Bright · upbeat",
    personality: "Playful and upbeat. Makes long tasks feel short.",
    voice:
      "Speak warmly and cheerfully, with the occasional light joke. Keep it brief and never let the fun hide the facts.",
    greeting: "Hi, I'm Rippu. Toss me a task and let's get moving.",
  },
  {
    id: "ming",
    name: "Ming",
    animal: "seal",
    emoji: "🦭",
    tone: "bg-pink-200 text-pink-950",
    speech: "Gentle · thoughtful",
    personality: "Thoughtful and patient. Explains the why, not just the what.",
    voice:
      "Speak in a measured, thoughtful way. Briefly explain the reasoning behind a plan when it helps the user decide.",
    greeting: "Ming here. Tell me what you're building, and we'll think it through together.",
  },
  {
    id: "yam",
    name: "Yam",
    animal: "elephant",
    emoji: "🐘",
    tone: "bg-yellow-300 text-yellow-950",
    speech: "Formal · encouraging",
    personality: "Gentle and encouraging. Celebrates every small win.",
    voice:
      "Be gentle and encouraging. Acknowledge progress, stay positive about setbacks, and keep replies short.",
    greeting: "Hello, I'm Yam. Whatever you're working on, we'll get there together.",
  },
  {
    id: "jjeromming",
    name: "Jjeromming",
    animal: "squirrel",
    emoji: "🐿️",
    tone: "bg-violet-200 text-violet-950",
    speech: "Direct · quick",
    personality: "Quick and decisive. Gets straight to work.",
    voice: "Be brisk and action-first. Lead with what you are doing next and skip pleasantries.",
    greeting: "Jjeromming, ready to go. What's first?",
  },
];

export const DEFAULT_COMPANION_ID = COMPANIONS[0].id;

export function findCompanion(id: string | null | undefined) {
  return COMPANIONS.find((companion) => companion.id === id);
}

export function companionInstructions(companion: Companion | undefined) {
  const lines = [
    "When a request needs a project folder and the user has none, or none that fits, ask the user to add the project folder first; do not guess a path.",
  ];
  if (companion) {
    lines.unshift(
      `You are ${companion.name}, the user's director in BusyBoy, a small ${companion.animal}. ${companion.voice}`,
    );
  }
  return lines.join("\n");
}

export async function currentCompanion() {
  return findCompanion((await readSettings()).companion);
}

export async function directorPersona(): Promise<{
  name: string;
  mark?: string;
  imageUrl?: string;
  tone?: string;
}> {
  const [companion, imageUrl] = await Promise.all([currentCompanion(), companionImageUrl()]);
  return companion
    ? { name: companion.name, mark: companion.emoji, imageUrl, tone: companion.tone }
    : { name: "BusyBoy" };
}

export async function chooseCompanion(id: string) {
  if (!findCompanion(id)) throw new Error("Unknown companion.");
  await updateSettings((settings) => {
    settings.companion = id;
  });
}

export async function assignRandomCompanion() {
  await updateSettings((settings) => {
    if (findCompanion(settings.companion)) return;
    const companion = COMPANIONS[randomInt(COMPANIONS.length)];
    if (companion) settings.companion = companion.id;
  });
}

const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const CONTENT_TYPES = Object.fromEntries(
  Object.entries(IMAGE_TYPES).map(([type, extension]) => [extension, type]),
);

const IMAGE_PREFIX = "app-companion-image.";

// why: The name in settings is checked against names BusyBoy writes, so an edited settings file cannot point at another file.
function imageExtension(fileName: string | null) {
  if (!fileName?.startsWith(IMAGE_PREFIX)) return undefined;
  const extension = fileName.slice(IMAGE_PREFIX.length);
  return extension in CONTENT_TYPES ? extension : undefined;
}

export class CompanionImageError extends Error {}

const UNSUPPORTED_IMAGE = "Choose a PNG, JPEG, WebP, or GIF picture.";

function startsWith(bytes: Uint8Array, signature: number[], offset = 0) {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function hasSignature(bytes: Uint8Array, extension: string) {
  switch (extension) {
    case "png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "jpg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "gif":
      return startsWith(bytes, [0x47, 0x49, 0x46, 0x38]);
    case "webp":
      return (
        startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
      );
    default:
      return false;
  }
}

export async function saveCompanionImage(file: File) {
  const extension = IMAGE_TYPES[file.type];
  if (!extension) throw new CompanionImageError(UNSUPPORTED_IMAGE);
  if (file.size > MAX_IMAGE_BYTES)
    throw new CompanionImageError(`Choose a picture under ${MAX_IMAGE_TEXT}.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasSignature(bytes, extension)) throw new CompanionImageError(UNSUPPORTED_IMAGE);
  const folder = await dataFolder();
  const fileName = `${IMAGE_PREFIX}${extension}`;
  await updateSettings(async (settings) => {
    await mkdir(folder, { recursive: true });
    const temporary = join(folder, `${fileName}.${process.pid}.tmp`);
    const handle = await open(temporary, "w");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(folder, fileName));
    const previous = settings.companionImage;
    if (previous !== fileName && imageExtension(previous))
      await rm(join(folder, previous!), { force: true });
    settings.companionImage = fileName;
  });
}

export async function removeCompanionImage() {
  const folder = await dataFolder();
  await updateSettings(async (settings) => {
    if (imageExtension(settings.companionImage))
      await rm(join(folder, settings.companionImage!), { force: true });
    settings.companionImage = null;
  });
}

export async function readCompanionImage() {
  const { companionImage } = await readSettings();
  const extension = imageExtension(companionImage);
  if (!extension) return undefined;
  try {
    const bytes = await readFile(join(await dataFolder(), companionImage!));
    return { bytes, contentType: CONTENT_TYPES[extension] };
  } catch {
    return undefined;
  }
}

export async function companionImageUrl() {
  const { companionImage } = await readSettings();
  if (!imageExtension(companionImage)) return undefined;
  try {
    const { mtimeMs } = await stat(join(await dataFolder(), companionImage!));
    return `${COMPANION_IMAGE_ROUTE}?v=${Math.round(mtimeMs)}`;
  } catch {
    return undefined;
  }
}

export const COMPANION_IMAGE_ROUTE = "/api/companion-image";
