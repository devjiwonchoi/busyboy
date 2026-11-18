import { memoryPrompt } from "../memory";
import { DIRECTOR_INSTRUCTIONS } from "./context";

// why: Ordered from least to most often changed, so a memory edit keeps the rest of the prompt cached.
export async function directorPrompt(folder: string) {
  return `${DIRECTOR_INSTRUCTIONS}\n\n${await memoryPrompt(folder, { projectIndexes: true })}`;
}
