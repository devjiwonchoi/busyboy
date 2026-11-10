import {
  type EnvironmentId,
  formatTaskKey,
  type ProjectTaskId,
  type ProjectTaskReference,
} from "@t3tools/contracts";

import { ChevronRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { CloudBadge } from "../CloudBadge";
import { TaskRowMarkers, useTaskRelations } from "../task/TaskRelations";
import { blockedByLabel } from "../task/taskRelations.logic";
import { resolveLiveTaskStatus } from "../task/taskStatus";
import { SidebarRowLine, SidebarTaskKey } from "./SidebarRowLine";

/** One task row with no session: its status icon, key and title; opens the task page. */
export function SidebarTaskRow(props: {
  task: ProjectTaskReference;
  taskKeyPrefix: string;
  environmentId: EnvironmentId;
  depth: number;
  isActive: boolean;
  onOpen: (task: ProjectTaskReference) => void;
  toggle?: { expanded: boolean; onToggle: () => void } | undefined;
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
      data-tree-depth={props.depth}
      className="relative list-none py-px"
      style={{ paddingLeft: 26 + props.depth * 14 }}
    >
      {props.toggle ? <SidebarTreeToggle {...props.toggle} /> : null}
      <button
        type="button"
        aria-label={`${key} ${task.title}, ${status.label}${blocked}`}
        aria-current={props.isActive ? "page" : undefined}
        onClick={() => props.onOpen(task)}
        className={cn(
          "@container/task-row group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
      >
        <SidebarRowLine
          title={
            <span aria-hidden className="flex min-w-0 flex-1 items-center gap-1.5">
              <SidebarTaskKey taskKey={key} />
              <span className="min-w-0 truncate text-sm font-medium">{task.title}</span>
              <TaskRowMarkers relations={relations} />
            </span>
          }
          status={status}
          indicators={
            task.location === "cloud" || task.memoryHold != null ? (
              <>
                <MemoryHoldLabel task={task} />
                {task.location === "cloud" ? <CloudBadge variant="icon" /> : null}
              </>
            ) : undefined
          }
        />
      </button>
    </li>
  );
}

/** A task held for memory, waiting to start or paused: a small muted "메모리 대기". */
export function MemoryHoldLabel(props: { task: Pick<ProjectTaskReference, "memoryHold"> }) {
  if (props.task.memoryHold == null) return null;
  return (
    <span
      data-memory-hold={props.task.memoryHold}
      className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground"
    >
      메모리 대기
    </span>
  );
}

/** A separate gutter button keeps toggling independent of navigation and mobile swipes. */
export function SidebarTreeToggle(props: { expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={props.expanded}
      aria-label={props.expanded ? "하위 태스크 접기" : "하위 태스크 펼치기"}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle();
      }}
      className="absolute top-1/2 z-10 flex size-7 -translate-x-full -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChevronRightIcon aria-hidden className={cn("size-3.5", props.expanded && "rotate-90")} />
    </button>
  );
}

export function SidebarThreadGroupRow(props: {
  taskId: ProjectTaskId;
  count: number;
  expanded: boolean;
  depth: number;
  onToggle: () => void;
}) {
  const label = `스레드 ${props.count}개`;
  return (
    <li
      data-thread-group={props.taskId}
      data-tree-depth={props.depth}
      className="list-none py-px"
      style={{ paddingLeft: 26 + props.depth * 14 }}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={props.expanded}
        onClick={props.onToggle}
        className="flex min-h-7 w-full items-center gap-1 rounded-md px-1 text-left text-xs text-muted-foreground hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRightIcon aria-hidden className={cn("size-3.5", props.expanded && "rotate-90")} />
        {label}
      </button>
    </li>
  );
}
