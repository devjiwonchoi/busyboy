"use server";

import { dataFolder } from "@/server/config";
import { sendToDirector, stopDirector } from "@/server/director/chat";
import { requireTrustedRequest } from "@/server/trusted-request";

const MAX_MESSAGE_LENGTH = 100_000;

export async function sendToDirectorAction(text: string): Promise<{ error?: string }> {
  await requireTrustedRequest();
  if (typeof text !== "string" || text.length > MAX_MESSAGE_LENGTH) {
    throw new Error("A message must be non-empty text of at most 100,000 characters.");
  }
  return sendToDirector({ folder: dataFolder(), text });
}

export async function stopDirectorAction() {
  await requireTrustedRequest();
  await stopDirector(dataFolder());
}
