import type { EnvironmentId, ProjectTaskId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, HourglassIcon, Link2Icon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useEnvironmentIds } from "~/state/environments";
import { useProjectManagerEntries } from "~/state/projectTeam";
import { taskRouteParams } from "~/taskRoutes";
import { GlyphWithLabel, StatusGlyphWithLabel } from "../sidebar/SidebarRowLine";
import {
  blockedByKeys,
  blockedByLabel,
  buildTaskRelationsIndex,
  type RelatedTask,
  type SubtaskProgress,
  type TaskRelations,
  type TaskRelationsIndex,
  relatedTask,
  taskRelations,
} from "./taskRelations.logic";
import { useLiveTaskStatus } from "./taskStatus";

/** Every task the app knows, across projects, for relation lookups. */
export function useTaskRelationsIndex(): TaskRelationsIndex {
  const entries = useProjectManagerEntries(useEnvironmentIds());
  return buildTaskRelationsIndex(entries);
}

export function useTaskRelations(
  environmentId: EnvironmentId,
  taskId: ProjectTaskId | null,
): TaskRelations | null {
  const index = useTaskRelationsIndex();
  return taskId === null ? null : taskRelations(index, environmentId, taskId);
}

/** One task with its key and live stage, from the PM summaries the app already holds. */
export function useRelatedTask(
  environmentId: EnvironmentId,
  taskId: ProjectTaskId | null,
): RelatedTask | null {
  const index = useTaskRelationsIndex();
  return taskId === null ? null : relatedTask(index, environmentId, taskId);
}

// An hourglass for "waits on" and a chain for "blocking": neither reads as priority.
const BLOCKED_CLASS = "text-orange-500 dark:text-orange-400";
const BLOCKING_CLASS = "text-red-500 dark:text-red-400";

/**
 * "⏳ BU-66" on a task row: the task waits on an unfinished one. Names it in full on
 * hover or long-press.
 */
export function WaitingMarker(props: {
  blockedBy: ReadonlyArray<RelatedTask>;
  className?: string;
  /** Hides the keys where the row is too narrow; the label still names them. */
  keysClassName?: string;
}) {
  if (props.blockedBy.length === 0) return null;
  const label = blockedByLabel(props.blockedBy);
  return (
    <span
      data-waiting-marker
      className={cn("relative z-10 inline-flex shrink-0", BLOCKED_CLASS, props.className)}
    >
      <span className="sr-only">{label}</span>
      <GlyphWithLabel label={label} testId="waiting-marker-trigger">
        <span aria-hidden className="inline-flex items-center gap-0.5 font-mono text-2xs">
          <HourglassIcon data-waiting-icon className="size-3" />
          <span data-waiting-keys className={props.keysClassName}>
            {blockedByKeys(props.blockedBy)}
          </span>
        </span>
      </GlyphWithLabel>
    </span>
  );
}

/** Linear's sub-issue ring: a thin track whose arc fills as subtasks finish. */
export function ProgressRing(props: { progress: SubtaskProgress; className?: string }) {
  const { done, total } = props.progress;
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  const fraction = total === 0 ? 0 : done / total;
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 14"
      className={cn("size-3.5 shrink-0 -rotate-90", props.className)}
    >
      <circle cx="7" cy="7" r={radius} fill="none" strokeWidth="2" className="stroke-border" />
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${Math.max(fraction * circumference, 0.01)} ${circumference}`}
        className={fraction === 1 ? "stroke-success" : "stroke-info"}
      />
    </svg>
  );
}

/** "◔ 2/5": a parent's subtask progress. */
export function SubtaskProgressBadge(props: { progress: SubtaskProgress; className?: string }) {
  const { done, total } = props.progress;
  return (
    <span
      data-subtask-progress={`${done}/${total}`}
      title={`${done} of ${total} subtasks done`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-muted-foreground text-xs tabular-nums",
        props.className,
      )}
    >
      <ProgressRing progress={props.progress} />
      <span aria-hidden>{`${done}/${total}`}</span>
      <span className="sr-only">{`${done} of ${total} subtasks done`}</span>
    </span>
  );
}

/** The plan card's one line: "Part of BU-53 · Blocked by BU-55 · 2/5 subtasks". */
export function TaskStructureLine(props: { relations: TaskRelations | null }) {
  const { relations } = props;
  if (relations === null) return null;
  const parts: ReactNode[] = [];
  if (relations.parent !== null) {
    parts.push(
      <span key="parent" className="min-w-0 truncate">
        Part of <RelatedTaskKey related={relations.parent} />
      </span>,
    );
  }
  if (relations.blockedBy.length > 0) {
    parts.push(
      <span key="blocked" className="inline-flex min-w-0 items-center gap-1">
        <HourglassIcon aria-hidden className={cn("size-3 shrink-0", BLOCKED_CLASS)} />
        <span className="truncate">
          Blocked by{" "}
          {relations.blockedBy.map((related, position) => (
            <span key={related.task.id}>
              {position > 0 ? ", " : null}
              <RelatedTaskKey related={related} />
            </span>
          ))}
        </span>
      </span>,
    );
  }
  if (relations.progress !== null) {
    parts.push(
      <span key="subtasks" className="inline-flex items-center gap-1">
        <ProgressRing progress={relations.progress} />
        {`${relations.progress.done}/${relations.progress.total} subtasks`}
      </span>,
    );
  }
  if (parts.length === 0) return null;
  return (
    <div
      data-task-structure-line
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground text-xs"
    >
      {parts.flatMap((part, position) =>
        position === 0
          ? [part]
          : [
              <span key={`dot-${position}`} aria-hidden>
                ·
              </span>,
              part,
            ],
      )}
    </div>
  );
}

function RelatedTaskKey(props: { related: RelatedTask }) {
  const { related } = props;
  return (
    <Link
      {...taskRouteParams(related.environmentId, related.projectId, related.task.id)}
      title={related.task.title}
      className="font-mono text-foreground/80 hover:text-foreground hover:underline"
    >
      {related.key}
    </Link>
  );
}

/** "BU-53 Director ›" above a subtask's title, like Linear's parent breadcrumb. */
export function TaskParentBreadcrumb(props: { relations: TaskRelations | null }) {
  const parent = props.relations?.parent ?? null;
  if (parent === null) return null;
  return (
    <Link
      {...taskRouteParams(parent.environmentId, parent.projectId, parent.task.id)}
      data-task-parent={parent.key}
      className="inline-flex max-w-full items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
    >
      <span className="font-mono">{parent.key}</span>
      <span className="min-w-0 truncate">{parent.task.title}</span>
      <ChevronRightIcon aria-hidden className="size-3 shrink-0" />
    </Link>
  );
}

/**
 * Linear's relation lists for one task: Sub-tasks with progress, Blocked by (hourglass),
 * Blocking (chain) and Related (finished links). Each row opens its task.
 */
export function TaskStructure(props: { relations: TaskRelations | null; className?: string }) {
  const { relations } = props;
  if (relations === null) return null;
  const empty =
    relations.subtasks.length === 0 &&
    relations.blockedBy.length === 0 &&
    relations.blocking.length === 0 &&
    relations.related.length === 0;
  if (empty) return null;
  return (
    <section
      aria-label="Structure"
      data-task-structure
      className={cn("flex flex-col gap-3", props.className)}
    >
      {relations.progress !== null ? (
        <RelationGroup
          label="Sub-tasks"
          name="subtasks"
          adornment={<SubtaskProgressBadge progress={relations.progress} />}
          tasks={relations.subtasks}
        />
      ) : null}
      <RelationGroup
        label="Blocked by"
        name="blocked-by"
        icon={<HourglassIcon aria-hidden className={cn("size-3", BLOCKED_CLASS)} />}
        tasks={relations.blockedBy}
      />
      <RelationGroup
        label="Blocking"
        name="blocking"
        icon={<Link2Icon aria-hidden className={cn("size-3", BLOCKING_CLASS)} />}
        tasks={relations.blocking}
      />
      <RelationGroup label="Related" name="related" tasks={relations.related} />
    </section>
  );
}

function RelationGroup(props: {
  label: string;
  name: string;
  icon?: ReactNode;
  adornment?: ReactNode;
  tasks: ReadonlyArray<RelatedTask>;
}) {
  if (props.tasks.length === 0) return null;
  return (
    <div data-relation-group={props.name}>
      <h3 className="mb-1 flex items-center gap-1.5 font-medium text-muted-foreground text-xs">
        {props.icon}
        {props.label}
        {props.adornment}
      </h3>
      <ul className="ml-1.5 border-border border-l pl-2">
        {props.tasks.map((related) => (
          <RelatedTaskRow key={related.task.id} related={related} />
        ))}
      </ul>
    </div>
  );
}

/** One related task: status icon, key and title; the whole row opens it. */
export function RelatedTaskRow(props: { related: RelatedTask }) {
  const { related } = props;
  const status = useLiveTaskStatus(related.environmentId, related.task);
  return (
    <li
      data-related-task={related.key}
      data-task-status={status.status}
      className="relative flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-accent/50"
    >
      <span className={cn("relative z-10 inline-flex shrink-0", status.className)}>
        <StatusGlyphWithLabel status={status} />
      </span>
      <span className="shrink-0 font-mono text-muted-foreground text-xs">{related.key}</span>
      <Link
        {...taskRouteParams(related.environmentId, related.projectId, related.task.id)}
        className="min-w-0 truncate outline-none after:absolute after:inset-0 focus-visible:underline"
      >
        {related.task.title}
      </Link>
    </li>
  );
}

/**
 * A compact row's markers, after its title: subtask progress and the waiting marker.
 * The waiting keys show only when the row (an `@container/task-row`) leaves the title room.
 */
export function TaskRowMarkers(props: { relations: TaskRelations | null }) {
  const { relations } = props;
  if (relations === null) return null;
  if (relations.progress === null && relations.blockedBy.length === 0) return null;
  return (
    <span className="ml-1.5 inline-flex shrink-0 items-center gap-1.5">
      {relations.progress !== null ? (
        <SubtaskProgressBadge progress={relations.progress} className="text-2xs" />
      ) : null}
      <WaitingMarker
        blockedBy={relations.blockedBy}
        keysClassName="hidden @min-[15rem]/task-row:inline"
      />
    </span>
  );
}
