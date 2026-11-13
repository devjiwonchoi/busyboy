import {
  type ProjectMentionStatus,
  projectMentionHandle,
} from "@t3tools/shared/one-chat";

import { cn } from "~/lib/utils";

/** Projects whose name or handle starts with or contains the query, prefix matches first. */
export function filterMentions(
  statuses: ReadonlyArray<ProjectMentionStatus>,
  query: string,
): ProjectMentionStatus[] {
  const needle = query.toLowerCase();
  const rank = (status: ProjectMentionStatus) => {
    const handle = projectMentionHandle(status.name).toLowerCase();
    const name = status.name.toLowerCase();
    if (handle.startsWith(needle) || name.startsWith(needle)) return 0;
    if (handle.includes(needle) || name.includes(needle)) return 1;
    return 2;
  };
  return statuses
    .filter((status) => rank(status) < 2)
    .toSorted((a, b) => rank(a) - rank(b));
}

/** The @ list above the composer: each project with what it is doing. */
export function ProjectMentionMenu({
  items,
  activeIndex,
  onPick,
  onHover,
}: {
  items: ReadonlyArray<ProjectMentionStatus>;
  activeIndex: number;
  onPick: (status: ProjectMentionStatus) => void;
  onHover: (index: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul
      role="listbox"
      aria-label="Projects"
      data-one-chat-mention-menu
      className="absolute inset-x-0 bottom-full mb-1 max-h-60 overflow-y-auto rounded-lg border bg-popover p-1 shadow-md"
    >
      {items.map((status, index) => (
        <li
          key={status.projectId}
          role="option"
          aria-selected={index === activeIndex}
          data-one-chat-mention={projectMentionHandle(status.name)}
          className={cn(
            "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
            index === activeIndex && "bg-muted",
          )}
          onMouseEnter={() => onHover(index)}
          onMouseDown={(event) => {
            // Keep the textarea focused and its caret where it was.
            event.preventDefault();
            onPick(status);
          }}
        >
          <span className="min-w-0 truncate">@{projectMentionHandle(status.name)}</span>
          <span className="ms-auto shrink-0 text-muted-foreground text-xs">{status.label}</span>
        </li>
      ))}
    </ul>
  );
}
