/** Default names, avatars, and voices for a project's PM. */

import type {
  ProjectManagerPersona,
  ProjectMemoryEntry,
  ProjectMergeOwner,
  ProjectTeamSettings,
} from "@t3tools/contracts";
import {
  directorInstructions,
  projectManagerInstructions,
} from "@t3tools/provider-core/server/orchestrationInstructions";

import * as Effect from "effect/Effect";

import type * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
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

/** The Director's default persona; the user can rename it like any PM. */
export const DIRECTOR_PERSONA: ProjectManagerPersona = {
  name: "Director",
  avatar: { kind: "emoji", emoji: "🧭" },
  voice: "chill",
};

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

/** What the PM does with a Ready pull request, by who merges in the project. */
export const mergeOwnerRule = (owner: ProjectMergeOwner): string =>
  owner === "user"
    ? "The user merges. Never merge a pull request yourself, even a clean Ready one, and never ask a task lead to. When a task turns Ready, send the user a short merge brief: what changed, the evidence (checks, the review model's clean review, local tests), the risk, and your recommendation (merge, or what to look at first)."
    : "You merge. When a task turns Ready and its pull request is clean (checks pass, no open threads, no conflict), squash-merge it yourself, then tell the user in one line. Releases still need the user's OK.";

/** The PM prompt section that says who merges. */
export const mergeOwnerSection = (owner: ProjectMergeOwner): string => `
### Merging

${mergeOwnerRule(owner)}
`;

/** The "[Merge owner] …" line telling a live PM the user changed who merges. */
export const mergeOwnerChangeText = (owner: ProjectMergeOwner): string =>
  `[Merge owner] The user changed who merges in this project. ${mergeOwnerRule(owner)} Use this from now on.`;

/**
 * The Director's "preferences" memory, for a PM prompt. Read-only for the PM: the user
 * changes it by telling the Director.
 */
export const workspacePreferencesSection = (content: string): string => `
### Workspace preferences (from the Director)

The user's preferences for every project, kept by the workspace Director. Follow them; they are read-only for you. Your own project memory wins where it is more specific. To change one, the user tells the Director.

${content.trim()}
`;

/**
 * The PM (or Director) instructions for a persona, then the Director's workspace
 * preferences, the project memory and the AFK rule when given.
 */
export const personaInstructions = (
  persona: ProjectManagerPersona,
  memory?: ReadonlyArray<ProjectMemoryEntry>,
  /** The AFK rule while the user is away when the session opens. */
  afkRule?: string,
  options?: {
    readonly kind?: "pm" | "director";
    /** The Director's "preferences" memory; only a PM's prompt carries it. */
    readonly workspacePreferences?: string | undefined;
    /** Who merges Ready pull requests; only a PM's prompt carries it. */
    readonly mergeOwner?: ProjectMergeOwner | undefined;
  },
): string => {
  const voice = {
    name: persona.name,
    voice: voiceText(persona.voice, persona.voiceCustom),
    voiceIsUserWords: isUserWordsVoice(persona.voice, persona.voiceCustom),
  };
  const director = options?.kind === "director";
  const preferences = options?.workspacePreferences?.trim();
  return (
    (director ? directorInstructions(voice) : projectManagerInstructions(voice)) +
    (!director && preferences ? workspacePreferencesSection(preferences) : "") +
    (director ? "" : mergeOwnerSection(options?.mergeOwner ?? "pm")) +
    (memory === undefined ? "" : pmMemorySection(memory)) +
    (afkRule === undefined ? "" : `\n### The user is AFK\n\n${afkRule}\n`)
  );
};

/** The Director's "preferences" memory for a PM's prompt; undefined for the Director itself or when there is none. */
export const workspacePreferencesFor = (
  repository: ProjectTeamRepository.ProjectTeamRepository["Service"],
  kind: "pm" | "director",
) =>
  kind === "director"
    ? Effect.succeed<string | undefined>(undefined)
    : Effect.gen(function* () {
        const director = (yield* repository.listManagers()).find(
          (manager) => manager.kind === "director",
        );
        if (director === undefined) return undefined;
        const memory = yield* repository.listMemory(director.projectId);
        return memory.find((entry) => entry.topic === "preferences")?.content;
      }).pipe(
        // Missing workspace preferences must never stop a PM session from opening.
        Effect.catchCause(() => Effect.succeed<string | undefined>(undefined)),
      );
