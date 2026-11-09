import type { ProjectTaskReference } from "@t3tools/contracts";
import { taskReferenceCandidates, type TaskReferenceCatalog } from "~/state/projectTeam.logic";

import {
  findAndReplaceText,
  type MarkdownNode,
  type TextMatch,
} from "~/vendor/mdast-find-and-replace";

const TASK_REFERENCE_PATTERN = /#[1-9]\d*/gu;
const WORD_CHARACTER_PATTERN = /[\p{L}\p{N}_]/u;
const IGNORED_TYPES = new Set(["link", "linkReference"]);
const TASK_KEY_PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/u;

const TASK_REFERENCE_HREF_PATTERN = /^t3-task:([1-9]\d*)$/u;

/** Read a stable task ID or a legacy project-local number from an in-app link. */
export function parseTaskReferenceHref(href: string): number | string | null {
  const match = TASK_REFERENCE_HREF_PATTERN.exec(href);
  if (match) {
    return Number(match[1]);
  }
  if (!href.startsWith("t3-task:")) {
    return null;
  }
  try {
    const id = decodeURIComponent(href.slice("t3-task:".length));
    return /^task[:-][^\s/]+$/u.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function taskReferenceHref(taskId: string) {
  return `t3-task:${encodeURIComponent(taskId)}`;
}

/** An unresolved historical key shows named choices, never an arbitrary project's task. */
export function parseTaskReferenceChoiceHref(href: string): string | null {
  const match = /^t3-task-key:([A-Z][A-Z0-9]{0,5}-[1-9]\d*)$/u.exec(href);
  return match?.[1] ?? null;
}

const isWordCharacter = (character: string | undefined) =>
  character !== undefined && WORD_CHARACTER_PATTERN.test(character);

/** True when "#N" is part of a thread's title, as in "CU eval chrome-form #1": a name, not a task. */
function insideThreadTitle(
  match: TextMatch,
  matched: string,
  threadTitles: ReadonlyArray<string>,
): boolean {
  const { input } = match;
  return threadTitles.some((title) => {
    const lower = title.trim().toLowerCase();
    for (
      let offset = lower.indexOf(matched);
      offset !== -1;
      offset = lower.indexOf(matched, offset + 1)
    ) {
      // "#1" inside a title's "#12" is not the same reference.
      if (/\d/u.test(lower[offset + matched.length] ?? "")) continue;
      const start = match.index - offset;
      const end = start + lower.length;
      if (start < 0 || input.slice(start, end).toLowerCase() !== lower) continue;
      // The title must stand as its own words, so "xCU eval #1" doesn't count.
      if (!isWordCharacter(input[start - 1]) && !isWordCharacter(input[end])) return true;
    }
    return false;
  });
}

/**
 * Turns "#N" and task keys such as "BU-7" into task chip links when N is one of the
 * project's tasks. Code is left alone, and so is "#N" inside a thread's title.
 */
export function remarkTaskReferences(options: {
  readonly tasks: ReadonlyMap<number, ProjectTaskReference>;
  readonly catalog?: TaskReferenceCatalog;
  readonly taskKeyPrefix?: string | null;
  readonly threadTitles?: ReadonlyArray<string>;
}) {
  const threadTitles = options.threadTitles ?? [];
  const prefix =
    options.taskKeyPrefix && TASK_KEY_PREFIX_PATTERN.test(options.taskKeyPrefix)
      ? options.taskKeyPrefix
      : null;
  const pattern =
    options.catalog && options.catalog.byKey.size > 0
      ? /#[1-9]\d*|[A-Z][A-Z0-9]{0,5}-[1-9]\d*/gu
      : prefix === null
        ? TASK_REFERENCE_PATTERN
        : new RegExp(`#[1-9]\\d*|${prefix}-[1-9]\\d*`, "gu");
  return (tree: MarkdownNode) => {
    findAndReplaceText(
      tree,
      pattern,
      (matched: string, match: TextMatch) => {
        const before = match.input[match.index - 1];
        const after = match.input[match.index + matched.length];
        if (isWordCharacter(before) || before === "&" || /[A-Za-z0-9_]/u.test(after ?? "")) {
          return false;
        }
        let number: number;
        if (matched.startsWith("#")) {
          if (insideThreadTitle(match, matched, threadTitles)) return false;
          number = Number(matched.slice(1));
        } else {
          // A key next to "-" is part of a longer name, such as "BU-7-draft".
          if (before === "-" || after === "-") return false;
          const candidates = options.catalog
            ? taskReferenceCandidates(options.catalog, matched)
            : [];
          if (candidates.length > 0) {
            const only = candidates.length === 1 ? candidates[0] : undefined;
            return {
              type: "link",
              url: only ? taskReferenceHref(only.task.id) : `t3-task-key:${matched}`,
              children: [{ type: "text", value: matched }],
            };
          }
          if (prefix === null || !matched.startsWith(`${prefix}-`)) return false;
          number = Number(matched.slice(prefix.length + 1));
        }
        const task = options.tasks.get(number);
        if (task === undefined) return false;
        return {
          type: "link",
          url: options.catalog?.byId.has(task.id)
            ? taskReferenceHref(task.id)
            : `t3-task:${task.number}`,
          children: [{ type: "text", value: matched }],
        };
      },
      IGNORED_TYPES,
    );
  };
}
