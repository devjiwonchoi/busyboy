"use server";

import { dataFolder } from "@/server/config";
import { sendToDirector, stopDirector } from "@/server/director/chat";

export async function sendToDirectorAction(form: FormData) {
  const text = form.get("text");
  if (typeof text !== "string") throw new Error("A message must be text.");
  await sendToDirector({ folder: await dataFolder(), text });
}

export async function stopDirectorAction() {
  await stopDirector(await dataFolder());
}
