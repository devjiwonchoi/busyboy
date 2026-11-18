import type { ImageMediaType } from "@/lib/chat-attachments";

export type TurnImage = { name: string; mediaType: ImageMediaType; data: string; path: string };

export type UserTurn = { text: string; note: string; images: TurnImage[] };

export function textTurn(text: string): UserTurn {
  return { text, note: "", images: [] };
}

export function combineTurns(turns: UserTurn[]): UserTurn {
  return {
    text: turns
      .map((turn) => turn.text.trim())
      .filter(Boolean)
      .join("\n\n"),
    note: turns
      .map((turn) => turn.note.trim())
      .filter(Boolean)
      .join("\n"),
    images: turns.flatMap((turn) => turn.images),
  };
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

export function harnessReceipt(turn: UserTurn) {
  const lines = [
    ...claudeContent(turn).flatMap((block) =>
      block.type === "image"
        ? [`image ${block.source.media_type} ${Buffer.from(block.source.data, "base64").length}`]
        : [],
    ),
    ...codexInput(turn).flatMap((item) =>
      item.type === "localImage" ? [`codex-image ${item.path}`] : [],
    ),
    ...turn.note
      .split("\n")
      .flatMap((line) =>
        line.startsWith("Attached file: ") ? [`file ${line.slice("Attached file: ".length)}`] : [],
      ),
  ];
  return lines.join("\n");
}
