import {
  type EnvironmentId,
  formatTaskKey,
  PROJECT_TASK_STATUS_LABELS,
  type ProjectId,
  type ProjectTaskReference,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { isElectron } from "~/env";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useRelativeTimeState } from "~/hooks/useRelativeTimeState";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { useEnvironmentIds } from "~/state/environments";
import { useProjectManagerEntries } from "~/state/projectTeam";
import { taskRouteParams } from "~/taskRoutes";
import { ProjectFavicon } from "../ProjectFavicon";
import { formatTaskPullRequestLabel, StatusGlyphWithLabel } from "../sidebar/SidebarRowLine";
import { useLiveTaskStatus } from "../task/taskStatus";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { type AllProjectsSection, buildAllProjectsSections } from "./allProjects.logic";

export const SHOW_DONE_TASKS_STORAGE_KEY = "busyboy:all-projects:show-done";

/** Every project and its tasks in one Linear-style list. Done tasks hide behind a toggle. */
export function AllProjectsPage() {
  const entries = useProjectManagerEntries(useEnvironmentIds());
  const [showDone, setShowDone] = useLocalStorage(
    SHOW_DONE_TASKS_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const projects = useProjects();
  const sections = buildAllProjectsSections(entries, showDone);
  const doneCount = sections.reduce((total, section) => total + section.doneCount, 0);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <h1 className="min-w-0 flex-1 truncate font-medium text-sm">All projects</h1>
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-muted-foreground text-xs">
            Show done ({doneCount})
            <Switch size="sm" checked={showDone} onCheckedChange={(next) => setShowDone(next)} />
          </label>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide" className="gap-8 px-3 sm:px-6">
            {sections.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No projects have a project manager yet. Tasks show up here once a project's manager
                creates them.
              </p>
            ) : (
              sections.map((section) => (
                <ProjectSection
                  key={`${section.environmentId}:${section.summary.projectId}`}
                  project={
                    projects.find(
                      (candidate) =>
                        candidate.environmentId === section.environmentId &&
                        candidate.id === section.summary.projectId,
                    ) ?? null
                  }
                  section={section}
                />
              ))
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function ProjectSection(props: {
  project: EnvironmentProject | null;
  section: AllProjectsSection;
}) {
  const { section, project } = props;
  const { environmentId, summary } = section;
  const title = project?.title ?? "Project";
  return (
    <section aria-label={title} data-all-projects-section={summary.projectId}>
      <header className="flex items-center gap-2 border-b border-border px-2 pb-2">
        {project !== null ? <ProjectFavicon project={project} className="size-4" /> : null}
        <h2 className="min-w-0 truncate font-medium text-sm">{title}</h2>
        <span className="shrink-0 text-muted-foreground text-xs">
          {section.openCount} open
          {section.doneCount > 0 ? ` · ${section.doneCount} done` : ""}
        </span>
      </header>
      {section.rows.length === 0 ? (
        <p className="px-2 py-3 text-muted-foreground text-sm">
          {summary.tasks.length === 0 ? "No tasks yet." : "No open tasks."}
        </p>
      ) : (
        <ul>
          {section.rows.map(({ task, depth }) => (
            <TaskListRow
              key={task.id}
              environmentId={environmentId}
              projectId={summary.projectId}
              task={task}
              depth={depth}
              taskKeyPrefix={summary.taskKeyPrefix}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function TaskListRow(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  task: ProjectTaskReference;
  depth: number;
  taskKeyPrefix: string;
}) {
  const { environmentId, task } = props;
  const status = useLiveTaskStatus(environmentId, task);
  const openPrLink = useOpenPrLink();
  const updated = useRelativeTimeState(task.updatedAt);
  const key = formatTaskKey(props.taskKeyPrefix, task.number);
  // The PR has its own column, so the status label leaves it out.
  const statusLabel =
    task.stage === "cancelled" ? status.label : PROJECT_TASK_STATUS_LABELS[status.status];
  return (
    <li
      data-all-projects-task={task.id}
      data-task-status={status.status}
      className="relative flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-border/60 px-2 py-2 hover:bg-accent/50 sm:flex-nowrap"
    >
      <div
        className={cn("flex min-w-0 basis-full items-center gap-2 sm:flex-1 sm:basis-auto")}
        style={{ paddingLeft: `${props.depth * 1.25}rem` }}
      >
        <span className={cn("relative z-10 inline-flex shrink-0", status.className)}>
          <StatusGlyphWithLabel status={status} />
        </span>
        <span className="shrink-0 font-mono text-muted-foreground text-xs">{key}</span>
        {/* The title link covers the whole row; the PR link sits above it. */}
        <Link
          {...taskRouteParams(environmentId, props.projectId, task.id)}
          className="min-w-0 text-sm break-words outline-none sm:truncate after:absolute after:inset-0 focus-visible:underline"
        >
          {task.title}
        </Link>
      </div>
      <div className="flex shrink-0 items-center gap-3 pl-6 text-muted-foreground text-xs sm:pl-0">
        <span className={cn("sm:w-28 sm:truncate", status.className)}>{statusLabel}</span>
        <span className="sm:w-16">
          {task.prUrl !== null ? (
            <a
              href={task.prUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => openPrLink(event, task.prUrl!)}
              className="relative z-10 hover:text-foreground hover:underline"
            >
              {formatTaskPullRequestLabel(task.prUrl)}
            </a>
          ) : null}
        </span>
        <span className="sm:w-16 sm:text-right" title={task.updatedAt ?? undefined}>
          {updated.status === "relative"
            ? updated.suffix
              ? `${updated.value} ${updated.suffix}`
              : updated.value
            : ""}
        </span>
      </div>
    </li>
  );
}
