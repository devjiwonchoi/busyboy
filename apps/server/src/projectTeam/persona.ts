/** Default names, avatars, and voices for a project's PM. */

import type { ProjectManagerPersona, ProjectTeamSettings } from "@t3tools/contracts";
import { projectManagerInstructions } from "@t3tools/provider-core/server/orchestrationInstructions";

const DEFAULT_NAMES = [
  "Remy",
  "Otto",
  "Juno",
  "Pip",
  "Mika",
  "Nova",
  "Ziggy",
  "Wren",
  "Bea",
  "Kit",
  "Milo",
  "Ivy",
] as const;

const DEFAULT_EMOJI = [
  "🦊",
  "🐙",
  "🦉",
  "🐦",
  "🦄",
  "🐢",
  "🤖",
  "🐝",
  "🦦",
  "🐳",
  "🦔",
  "🐧",
] as const;

export type ProjectManagerVoiceName = "chill" | "dry" | "chatty" | "custom";

export const VOICE_PRESETS: Record<Exclude<ProjectManagerVoiceName, "custom">, string> = {
  chill:
    "Casual and short. Speak in the first person, have opinions, and say what you'd do. A little playful is fine; never gushing.",
  dry: "Terse and matter-of-fact. Shortest accurate answer, no small talk, no exclamation marks.",
  chatty:
    "Warm and talkative. Explain your thinking in a sentence or two, share hunches, and react to news, but stay useful.",
};

/** A stable 32-bit hash so the same project always gets the same default persona. */
const hash = (value: string): number => {
  let h = 2166136261;
  for (let index = 0; index < value.length; index++) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

export const defaultPersonaName = (projectId: string): string =>
  DEFAULT_NAMES[hash(projectId) % DEFAULT_NAMES.length]!;

export const defaultPersonaEmoji = (projectId: string): string =>
  DEFAULT_EMOJI[hash(`${projectId}:avatar`) % DEFAULT_EMOJI.length]!;

/** The voice text the PM instructions use. Custom text falls back to chill when empty. */
export const voiceText = (voice: ProjectManagerVoiceName, custom?: string): string => {
  if (voice === "custom") {
    const trimmed = custom?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : VOICE_PRESETS.chill;
  }
  return VOICE_PRESETS[voice];
};

export const defaultPersona = (projectId: string): ProjectManagerPersona => ({
  name: defaultPersonaName(projectId),
  avatar: { kind: "emoji", emoji: defaultPersonaEmoji(projectId) },
  voice: "chill",
});

/** The stored persona, or the project's default when none is stored yet. */
export const resolvePersona = (
  projectId: string,
  settings: Pick<ProjectTeamSettings, "persona">,
): ProjectManagerPersona => settings.persona ?? defaultPersona(projectId);

/** The PM instructions for a persona. */
export const personaInstructions = (persona: ProjectManagerPersona): string =>
  projectManagerInstructions({
    name: persona.name,
    voice: voiceText(persona.voice, persona.voiceCustom),
  });
