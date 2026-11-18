"use server";

import { dataFolder } from "@/server/config";
import { sendToDirector, stopDirector } from "@/server/director/chat";
import { requireTrustedRequest } from "@/server/trusted-request";

const MAX_MESSAGE_LENGTH = 100_000;

export async function sendToDirectorAction(formData: FormData): Promise<{ error?: string }> {
  await requireTrustedRequest();
  const text = formData.get("text") ?? "";
  if (typeof text !== "string" || text.length > MAX_MESSAGE_LENGTH) {
    throw new Error("A message must be text of at most 100,000 characters.");
  }
  const files = formData.getAll("files").filter((value) => value instanceof File);
  return sendToDirector({ folder: dataFolder(), text, files });
}

export async function stopDirectorAction() {
  await requireTrustedRequest();
  await stopDirector(dataFolder());
}
