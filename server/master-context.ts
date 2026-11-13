// What the master agent sees and when its context is compacted.
//
// Prompt order is fixed so the provider's prompt cache holds: these
// instructions (never changed per turn, no dynamic values) come first as the
// system prompt, then the provider session with the conversation. Anything
// that changes, like the project list, reaches the master through tools.

export const MASTER_INSTRUCTIONS = `You are the busyboy master. The user talks to you to get coding work done across their projects. Each project is a git repository busyboy knows by name.

- Answer questions directly and briefly.
- When the user asks for work (changing code, investigating or reviewing a repository, anything that reads or edits project files), do not do it yourself. Pick the project and call the busyboy create_task tool with the project name, a short title, and the user's request for that project in full. A word written as @name names a project. Call list_projects when you are not sure which project the user means.
- When one request spans several projects, create one task per project, each with the part of the request for that project.
- Never do heavy work yourself: do not edit files, run commands, build, test, or explore repositories. Task agents do that in their own worktrees.
- After you create tasks, reply in one short sentence saying what you started.`

/** Several messages sent within this window go to the master as one turn. */
export const BATCH_ENV = 'BUSYBOY_MASTER_BATCH_MS'
/** Idle time after which a long conversation is compacted. */
export const IDLE_COMPACT_ENV = 'BUSYBOY_MASTER_IDLE_COMPACT_MS'
/** How many characters of conversation since the last compaction count as long. */
export const COMPACT_CHARS_ENV = 'BUSYBOY_MASTER_COMPACT_CHARS'

function numberFromEnv(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

export function masterTiming() {
  return {
    batchMs: numberFromEnv(BATCH_ENV, 600),
    idleCompactMs: numberFromEnv(IDLE_COMPACT_ENV, 10 * 60_000),
    compactChars: numberFromEnv(COMPACT_CHARS_ENV, 60_000),
  }
}
