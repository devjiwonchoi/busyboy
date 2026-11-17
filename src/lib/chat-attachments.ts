export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export type AttachmentInput = { name: string; mediaType: string; data: string };

export type MessageImage = { name: string; file: string; task?: string };

export function isMessageImages(value: unknown): value is MessageImage[] {
  return (
    Array.isArray(value) &&
    value.every(
      (image: Record<string, unknown> | null) =>
        image !== null &&
        typeof image === "object" &&
        typeof image.name === "string" &&
        typeof image.file === "string" &&
        (image.task === undefined || typeof image.task === "string"),
    )
  );
}

export function messageImageUrl(image: MessageImage, chat: string | null) {
  const owner: Record<string, string> = image.task ? { task: image.task } : chat ? { chat } : {};
  return `/api/chat-attachment?${new URLSearchParams({ ...owner, file: image.file }).toString()}`;
}

export function textWithImages(text: string, images: MessageImage[] | undefined) {
  return [text, ...(images ?? []).map((image) => `Image: ${image.name}`)].filter(Boolean).join("\n\n");
}

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_ATTACHMENTS = 4;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

const BLOCKED_EXTENSIONS = new Set([
  "exe",
  "dll",
  "bat",
  "cmd",
  "com",
  "msi",
  "scr",
  "app",
  "dmg",
  "pkg",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "jar",
]);

const EXTENSION_TYPES: Record<string, ImageMediaType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function imageMediaType(name: string, mediaType: string): ImageMediaType | null {
  const stated = mediaType === "image/jpg" ? "image/jpeg" : mediaType;
  if ((IMAGE_MEDIA_TYPES as readonly string[]).includes(stated)) return stated as ImageMediaType;
  if (stated.startsWith("image/")) return null;
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TYPES[extension] ?? null;
}

function extensionOf(name: string) {
  const base = name.split(/[/\\]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

export function attachmentProblem({
  name,
  mediaType,
  bytes,
  already,
  totalBytes,
}: {
  name: string;
  mediaType: string;
  bytes: number;
  already: number;
  totalBytes: number;
}) {
  if (already >= MAX_ATTACHMENTS) return `Attach up to ${MAX_ATTACHMENTS} files.`;
  if (bytes <= 0) return `${name || "That file"} is empty.`;
  if (totalBytes + bytes > MAX_TOTAL_BYTES) return "Attachments together can be at most 8 MB.";
  const image = mediaType.startsWith("image/") || imageMediaType(name, mediaType) !== null;
  if (image) {
    if (!imageMediaType(name, mediaType)) return "Use a PNG, JPEG, GIF, or WebP image.";
    if (bytes > MAX_IMAGE_BYTES) return `${name || "That image"} is larger than 4 MB.`;
    return null;
  }
  if (BLOCKED_EXTENSIONS.has(extensionOf(name))) return "That file type cannot be attached.";
  if (bytes > MAX_FILE_BYTES) return `${name || "That file"} is larger than 1 MB.`;
  return null;
}
