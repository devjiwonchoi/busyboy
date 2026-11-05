import type { EnvironmentId, ProjectTaskReference } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { resolveTaskStageStatus, StatusGlyph } from "../sidebar/SidebarRowLine";

const CHIP_CLASS_NAME =
  "inline-flex max-w-[18em] items-baseline gap-[0.3em] rounded-sm bg-muted px-[0.35em] align-baseline text-foreground no-underline hover:bg-accent";

/** "#N" in PM or task-lead text, shown with the task's title so the number means something. */
export function TaskReferenceChip(props: {
  readonly environmentId: EnvironmentId | null;
  readonly task: ProjectTaskReference;
}) {
  const { environmentId, task } = props;
  const content = (
    <>
      <span className="shrink-0 text-muted-foreground tabular-nums">#{task.number}</span>
      <span className="min-w-0 truncate">{task.title}</span>
    </>
  );
  const label = `#${task.number} ${task.title}`;
  const status = resolveTaskStageStatus(task);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          environmentId !== null && task.leadThreadId !== null ? (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: task.leadThreadId }}
              className={CHIP_CLASS_NAME}
              aria-label={label}
              data-task-reference-chip=""
              data-markdown-copy={label}
            />
          ) : (
            <span
              className={CHIP_CLASS_NAME}
              data-task-reference-chip=""
              data-markdown-copy={label}
            />
          )
        }
      >
        {content}
      </TooltipTrigger>
      <TooltipPopup>
        <div className="max-w-80 space-y-0.5">
          <div className="font-medium">{label}</div>
          <div className="flex items-center gap-1 text-muted-foreground">
            <span className={cn("inline-flex", status.className)}>
              <StatusGlyph icon={status.icon} />
            </span>
            {status.label}
          </div>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
