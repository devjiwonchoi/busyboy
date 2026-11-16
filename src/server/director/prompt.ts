import { companionInstructions, findCompanion } from '../companions'
import { readSettingsAt } from '../config'
import { memoryPrompt } from '../memory'
import { DIRECTOR_INSTRUCTIONS } from './context'

/**
 * The Director's system prompt: its instructions, the chosen companion's
 * voice, then the global facts and each project's fact count. Ordered from
 * least to most often changed, so a memory edit keeps the rest cached.
 */
export async function directorPrompt(folder: string) {
  const companion = findCompanion((await readSettingsAt(folder)).companion)
  return `${DIRECTOR_INSTRUCTIONS}\n\n${companionInstructions(companion)}\n\n${await memoryPrompt(folder, { projectIndexes: true })}`
}
