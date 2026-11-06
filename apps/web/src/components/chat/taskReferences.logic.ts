import type { ProjectTaskReference } from "@t3tools/contracts";

import {
  findAndReplaceText,
  type MarkdownNode,
  type TextMatch,
} from "~/vendor/mdast-find-and-replace";

const TASK_REFERENCE_PATTERN = /#[1-9]\d*/gu;
const WORD_CHARACTER_PATTERN = /[\p{L}\p{N}_]/u;
const IGNORED_TYPES = new Set(["link", "linkReference"]);

const TASK_REFERENCE_HREF_PATTERN = /^t3-task:([1-9]\d*)$/u;

/** The task number of a link made by remarkTaskReferences, or null for any other link. */
export function parseTaskReferenceHref(href: string): number | null {
  const match = TASK_REFERENCE_HREF_PATTERN.exec(href);
  return match ? Number(match[1]) : null;
}

/** Turns "#N" into a task chip link when N is one of the project's tasks. Code is left alone. */
export function remarkTaskReferences(options: {
  readonly tasks: ReadonlyMap<number, ProjectTaskReference>;
}) {
  return (tree: MarkdownNode) => {
    findAndReplaceText(
      tree,
      TASK_REFERENCE_PATTERN,
      (matched: string, match: TextMatch) => {
        const before = match.input[match.index - 1];
        const after = match.input[match.index + matched.length];
        if (
          (before !== undefined && (WORD_CHARACTER_PATTERN.test(before) || before === "&")) ||
          (after !== undefined && WORD_CHARACTER_PATTERN.test(after))
        ) {
          return false;
        }
        const task = options.tasks.get(Number(matched.slice(1)));
        if (task === undefined) return false;
        return {
          type: "link",
          url: `t3-task:${task.number}`,
          children: [{ type: "text", value: matched }],
        };
      },
      IGNORED_TYPES,
    );
  };
}
