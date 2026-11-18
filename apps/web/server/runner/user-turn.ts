import type { ImageMediaType } from "@/lib/chat-attachments";

type TurnImage = { name: string; mediaType: ImageMediaType; data: string; path: string };

export type UserTurn = { text: string; note: string; images: TurnImage[] };

export function textTurn(text: string): UserTurn {
  return { text, note: "", images: [] };
}

export function asTurn(turn: UserTurn | string): UserTurn {
  return typeof turn === "string" ? textTurn(turn) : turn;
}

export function modelText(turn: UserTurn) {
  return [turn.text.trim(), turn.note.trim()].filter(Boolean).join("\n\n");
}

export function displayText(turn: UserTurn) {
  return [turn.text.trim(), ...turn.images.map((image) => `Image: ${image.name}`), turn.note.trim()]
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
  const text = modelText(turn);
  return [
    ...turn.images.map((image) => ({ type: "localImage" as const, path: image.path })),
    ...(text ? [{ type: "text" as const, text, text_elements: [] as const }] : []),
  ];
}
