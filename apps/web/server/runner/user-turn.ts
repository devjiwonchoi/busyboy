import type { ImageMediaType } from "@/lib/chat-attachments";

export type TurnImage = { name: string; mediaType: ImageMediaType; data: string; path: string };

export type UserTurn = { text: string; files: string[]; images: TurnImage[] };

function modelText(turn: UserTurn, imagePaths = false) {
  return [
    turn.text.trim(),
    ...turn.files.map((path) => `Attached file: ${path}`),
    ...(imagePaths ? turn.images.map((image) => `Attached image: ${image.path}`) : []),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function claudeContent(turn: UserTurn) {
  const text = modelText(turn);
  return [
    ...turn.images.map((image) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
    })),
    ...(text ? [{ type: "text" as const, text }] : []),
  ];
}

export function codexInput(turn: UserTurn) {
  return [
    ...turn.images.map((image) => ({ type: "localImage" as const, path: image.path })),
    { type: "text" as const, text: modelText(turn) || " ", text_elements: [] as const },
  ];
}

export function grokPrompt(turn: UserTurn, allowImages: boolean) {
  return [
    ...(allowImages
      ? turn.images.map((image) => ({
          type: "image" as const,
          data: image.data,
          mimeType: image.mediaType,
        }))
      : []),
    { type: "text" as const, text: modelText(turn, !allowImages) || " " },
  ];
}
