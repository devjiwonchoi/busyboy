/** Default names, avatars, and voices for a project's PM. */

import type {
  ProjectManagerPersona,
  ProjectMemoryEntry,
  ProjectTeamSettings,
} from "@t3tools/contracts";
import { projectManagerInstructions } from "@t3tools/provider-core/server/orchestrationInstructions";

import { memoryPromptSection } from "./memoryPrompt.ts";

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

/** The user's custom voice on one line, so it reads as quoted data, not instructions. */
const cleanCustomVoice = (custom: string | undefined): string =>
  (custom ?? "")
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replaceAll('"', "'")
    .trim();

/** The voice text the PM instructions use. Custom text falls back to chill when empty. */
export const voiceText = (voice: ProjectManagerVoiceName, custom?: string): string => {
  if (voice === "custom") {
    const cleaned = cleanCustomVoice(custom);
    return cleaned.length > 0 ? cleaned : VOICE_PRESETS.chill;
  }
  return VOICE_PRESETS[voice];
};

/** True when the voice is the user's own words rather than a preset. */
export const isUserWordsVoice = (voice: ProjectManagerVoiceName, custom?: string): boolean =>
  voice === "custom" && cleanCustomVoice(custom).length > 0;

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

/**
 * The PM's copy of the project memory, taken when its session opens. It is part of the
 * system prompt, so it survives context compaction.
 */
export const pmMemorySection = (memory: ReadonlyArray<ProjectMemoryEntry>): string => `
### Project memory

The project's memory when this session started. Your own memory_write and memory_delete calls since then are newer than this copy.

${memoryPromptSection(memory)}
`;

/** The rule agents follow while the user is AFK; also part of the lead and PM prompts. */
export const AFK_AGENT_RULE =
  'The user is away (AFK). Do not wait on the user: take your recommended option and record the assumption in a task note. Questions and plan approvals you still raise are answered for the user after a minute with the "(Recommended)" option, or the first one. Anything irreversible or that only a person can do (merging, secrets, payments, deleting data) still waits: raise it as kind "blocker", which AFK never answers.';

/** The PM instructions for a persona, then the project memory and the AFK rule when given. */
export const personaInstructions = (
  persona: ProjectManagerPersona,
  memory?: ReadonlyArray<ProjectMemoryEntry>,
  /** The AFK rule while the user is away when the session opens. */
  afkRule?: string,
): string =>
  projectManagerInstructions({
    name: persona.name,
    voice: voiceText(persona.voice, persona.voiceCustom),
    voiceIsUserWords: isUserWordsVoice(persona.voice, persona.voiceCustom),
  }) +
  (memory === undefined ? "" : pmMemorySection(memory)) +
  (afkRule === undefined ? "" : `\n### The user is AFK\n\n${afkRule}\n`);
