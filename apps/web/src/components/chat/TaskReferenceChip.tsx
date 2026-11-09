import type { EnvironmentId, ProjectId, ProjectTaskReference } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { taskRouteParams } from "~/taskRoutes";
import { cn } from "~/lib/utils";
import { StatusGlyph } from "../sidebar/SidebarRowLine";
import { TaskPhaseBadge } from "../task/TaskPhaseBadge";
import { taskPhaseView } from "../task/taskPhase.logic";
import { useLiveTaskStatus } from "../task/taskStatus";

const CHIP_CLASS_NAME =
  "inline-flex max-w-full sm:max-w-[24em] items-baseline gap-[0.3em] rounded-sm bg-muted px-[0.35em] align-baseline text-foreground no-underline hover:bg-accent";

/** "#N" in PM or task-lead text, shown with the task's title so the number means something. */
export function TaskReferenceChip(props: {
  readonly environmentId: EnvironmentId | null;
  readonly task: ProjectTaskReference;
  readonly projectId?: ProjectId | undefined;
  readonly projectTitle?: string | undefined;
  readonly taskKey?: string | undefined;
}) {
  const { environmentId, task, projectId, projectTitle, taskKey } = props;
  const label = projectTitle ? `${task.title} · ${projectTitle}` : `#${task.number} ${task.title}`;
  const status = useLiveTaskStatus(environmentId, task);
  const phase = taskPhaseView({ ...task, status: status.status });
  const content = (
    <>
      {projectTitle ? (
        <>
          <span className="min-w-0 truncate">{task.title}</span>
          <span className="max-w-[50%] shrink-0 truncate text-muted-foreground">
            · {projectTitle}
          </span>
        </>
      ) : (
        <>
          <span className="shrink-0 text-muted-foreground tabular-nums">#{task.number}</span>
          <span className="min-w-0 truncate">{task.title}</span>
        </>
      )}
      <TaskPhaseBadge view={phase} compact className="self-center" />
    </>
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          environmentId !== null && projectId !== undefined ? (
            <Link
              {...taskRouteParams(environmentId, projectId, task.id)}
              className={CHIP_CLASS_NAME}
              aria-label={label}
              data-task-reference-chip=""
              data-markdown-copy={label}
            />
          ) : environmentId !== null && task.leadThreadId !== null ? (
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
          {taskKey ? <div className="text-muted-foreground text-xs">({taskKey})</div> : null}
          <div className="flex items-center gap-1 text-muted-foreground">
            <span className={cn("inline-flex", status.className)}>
              <StatusGlyph icon={status.icon} />
            </span>
            {status.label}
          </div>
          <TaskPhaseBadge view={phase} />
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
