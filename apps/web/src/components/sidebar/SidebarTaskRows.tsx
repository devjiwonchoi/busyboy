import {
  type EnvironmentId,
  formatTaskKey,
  type ProjectTaskId,
  type ProjectTaskReference,
  type ProjectTeamAttentionSummary,
} from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { TaskRowMarkers, useTaskRelations } from "../task/TaskRelations";
import { blockedByLabel } from "../task/taskRelations.logic";
import { resolveLiveTaskStatus } from "../task/taskStatus";
import { SidebarRowLine } from "./SidebarRowLine";

const HIDDEN_STAGES: ReadonlySet<ProjectTaskReference["stage"]> = new Set(["done", "cancelled"]);

/**
 * Open tasks with no agent session yet, in number order with subtasks right
 * after their parent. Tasks with a lead show as that lead's thread row instead.
 */
export function selectSidebarTasksWithoutSession(
  summary: Pick<ProjectTeamAttentionSummary, "tasks">,
): ReadonlyArray<{ readonly task: ProjectTaskReference; readonly depth: number }> {
  const open = summary.tasks.filter(
    (task) => task.leadThreadId === null && !HIDDEN_STAGES.has(task.stage),
  );
  const ids = new Set(open.map((task) => task.id));
  const childrenOf = new Map<ProjectTaskId, ProjectTaskReference[]>();
  const roots: ProjectTaskReference[] = [];
  for (const task of open.toSorted((a, b) => a.number - b.number)) {
    if (task.parentTaskId !== null && ids.has(task.parentTaskId)) {
      childrenOf.set(task.parentTaskId, [...(childrenOf.get(task.parentTaskId) ?? []), task]);
    } else {
      roots.push(task);
    }
  }
  const rows: Array<{ task: ProjectTaskReference; depth: number }> = [];
  const visit = (task: ProjectTaskReference, depth: number) => {
    rows.push({ task, depth });
    for (const child of childrenOf.get(task.id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

/** One task row with no session: its status icon, key and title; opens the task page. */
export function SidebarTaskRow(props: {
  task: ProjectTaskReference;
  taskKeyPrefix: string;
  environmentId: EnvironmentId;
  depth: number;
  isActive: boolean;
  onOpen: (task: ProjectTaskReference) => void;
}) {
  const { task } = props;
  const key = formatTaskKey(props.taskKeyPrefix, task.number);
  // These tasks have no lead thread, so only the stored state counts.
  const status = resolveLiveTaskStatus(task, null);
  const relations = useTaskRelations(props.environmentId, task.id);
  const blocked =
    relations !== null && relations.blockedBy.length > 0
      ? `, ${blockedByLabel(relations.blockedBy)}`
      : "";
  return (
    <li
      data-task-item={task.id}
      className={cn("list-none py-px", props.depth === 0 ? "pl-6.5" : "pl-10")}
    >
      <button
        type="button"
        aria-label={`${key} ${task.title}, ${status.label}${blocked}`}
        aria-current={props.isActive ? "page" : undefined}
        onClick={() => props.onOpen(task)}
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
      >
        <SidebarRowLine
          title={
            <span aria-hidden className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="shrink-0 font-mono text-2xs text-sidebar-muted-foreground">
                {key}
              </span>
              <span className="min-w-0 truncate text-sm font-medium">{task.title}</span>
              <TaskRowMarkers relations={relations} />
            </span>
          }
          status={status}
        />
      </button>
    </li>
  );
}
