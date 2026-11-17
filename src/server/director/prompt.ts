import { companionInstructions, findCompanion } from "../companions";
import { readSettingsAt } from "../config";
import { memoryPrompt } from "../memory";
import { DIRECTOR_INSTRUCTIONS, managerInstructions } from "./context";

// Ordered from least to most often changed, so a memory edit keeps the rest of the prompt cached.
export async function directorPrompt(folder: string) {
  const companion = findCompanion((await readSettingsAt(folder)).companion);
  return `${DIRECTOR_INSTRUCTIONS}\n\n${companionInstructions(companion)}\n\n${await memoryPrompt(folder, { projectIndexes: true })}`;
}

export async function managerPrompt(folder: string, manager: { name: string; project: string }) {
  return `${managerInstructions(manager.name, manager.project)}\n\n${await memoryPrompt(folder, { projectIndexes: true })}`;
}
