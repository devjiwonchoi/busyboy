import type { ProjectMemoryEntry } from "@t3tools/contracts";

type MemoryEntry = Pick<ProjectMemoryEntry, "topic" | "content" | "updatedAt">;

/**
 * Characters of memory a prompt carries in full. Past it, only core topics stay
 * whole and the rest become a one-line index; the PM is told to tidy up.
 */
export const MEMORY_PROMPT_BUDGET = 12_000;

/** Index lines quote this much of a topic's first line. */
const INDEX_LINE_MAX_LENGTH = 120;

/** The user's preferences and decisions: kept whole in every prompt when they fit. */
export const isCoreMemoryTopic = (topic: string): boolean =>
  topic === "preferences" || topic.startsWith("decisions");

const fullText = (entry: MemoryEntry) => `### ${entry.topic}\n${entry.content}`;

const day = (entry: MemoryEntry) => entry.updatedAt.slice(0, 10);

/** Total size of the memory as prompts count it. */
export const memorySize = (memory: ReadonlyArray<MemoryEntry>): number =>
  memory.reduce((sum, entry) => sum + entry.topic.length + entry.content.length, 0);

const newestFirst = (a: MemoryEntry, b: MemoryEntry) => b.updatedAt.localeCompare(a.updatedAt);

function indexLine(entry: MemoryEntry): string {
  const first = (entry.content.split("\n").find((line) => line.trim().length > 0) ?? "")
    .replace(/^[-*]\s*/, "")
    .trim();
  const cut =
    first.length > INDEX_LINE_MAX_LENGTH
      ? `${first.slice(0, INDEX_LINE_MAX_LENGTH - 1).trimEnd()}…`
      : first;
  return `- ${entry.topic} (${day(entry)})${cut.length > 0 ? `: ${cut}` : ""}`;
}

/**
 * Project memory for an agent prompt. Small memory goes in whole. Large memory keeps
 * the core topics (preferences, decisions*) whole, newest first, while they fit the
 * budget, and lists every other topic as one dated line to read with memory_list.
 */
export function memoryPromptSection(
  memory: ReadonlyArray<MemoryEntry>,
  budget: number = MEMORY_PROMPT_BUDGET,
): string {
  if (memory.length === 0) return "No project memory yet.";
  const core = memory.filter((entry) => isCoreMemoryTopic(entry.topic)).toSorted(newestFirst);
  const rest = memory.filter((entry) => !isCoreMemoryTopic(entry.topic)).toSorted(newestFirst);
  if (memorySize(memory) <= budget) {
    return [...core, ...rest].map(fullText).join("\n\n");
  }
  const whole: Array<MemoryEntry> = [];
  const indexed: Array<MemoryEntry> = [];
  let used = 0;
  for (const entry of core) {
    const size = entry.topic.length + entry.content.length;
    if (used + size <= budget) {
      whole.push(entry);
      used += size;
    } else {
      indexed.push(entry);
    }
  }
  indexed.push(...rest);
  return [
    ...whole.map(fullText),
    [
      "### Other topics (read them with memory_list)",
      ...indexed.toSorted(newestFirst).map(indexLine),
    ].join("\n"),
  ].join("\n\n");
}

/** How many oldest topics an over-budget note names. */
const OLDEST_TOPICS_NAMED = 5;

/**
 * A note for the PM when memory has outgrown the prompt budget, or null when it fits.
 * Names the oldest topics, the likeliest to be stale.
 */
export function memoryOverBudgetNote(
  memory: ReadonlyArray<MemoryEntry>,
  budget: number = MEMORY_PROMPT_BUDGET,
): string | null {
  const size = memorySize(memory);
  if (size <= budget) return null;
  const oldest = memory
    .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .slice(0, OLDEST_TOPICS_NAMED)
    .map((entry) => `${entry.topic} (${day(entry)})`)
    .join(", ");
  return `Memory is over budget (${size.toLocaleString("en-US")} of ${budget.toLocaleString("en-US")} chars): merge overlapping topics and delete superseded or finished-task detail. Oldest: ${oldest}.`;
}
