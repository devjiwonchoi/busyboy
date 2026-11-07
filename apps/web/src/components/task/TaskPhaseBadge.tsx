import type { EnvironmentId, ProjectTaskReference } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import {
  type TaskPhaseStep,
  type TaskPhaseTone,
  type TaskPhaseView,
  taskPhaseView,
} from "./taskPhase.logic";
import { useLiveTaskStatus } from "./taskStatus";

const STEP_FILL: Record<TaskPhaseTone, Record<TaskPhaseStep["state"], string>> = {
  active: {
    done: "bg-info",
    current: "bg-blue-300 dark:bg-blue-700",
    upcoming: "bg-muted-foreground/25",
  },
  ready: { done: "bg-success", current: "bg-success", upcoming: "bg-muted-foreground/25" },
  done: { done: "bg-muted-foreground/50", current: "", upcoming: "" },
};

const TEXT_CLASS: Record<TaskPhaseTone, string> = {
  active: "text-foreground",
  ready: "text-success",
  done: "text-muted-foreground",
};

/** Three Linear-style segments, one per phase. */
function PhaseSteps(props: { view: TaskPhaseView }) {
  return (
    <span aria-hidden className="inline-flex shrink-0 items-center gap-0.5">
      {props.view.steps.map((step) => (
        <span
          key={step.phase}
          data-phase-step={step.phase}
          data-phase-step-state={step.state}
          className={cn(
            "h-1.5 w-2.5 rounded-full",
            STEP_FILL[props.view.tone][step.state],
            step.state === "current" &&
              props.view.tone === "active" &&
              "animate-pulse motion-reduce:animate-none",
          )}
        />
      ))}
    </span>
  );
}

/**
 * The task's phase: 계획 → 구현·리뷰 → 배포, with the round once a phase repeats.
 * `compact` shows only the segments, for inline chips whose tooltip carries the label.
 */
export function TaskPhaseBadge(props: {
  view: TaskPhaseView | null;
  compact?: boolean | undefined;
  className?: string | undefined;
}) {
  const { view } = props;
  if (view === null) return null;
  return (
    <span
      data-task-phase={view.phase ?? "done"}
      data-task-phase-tone={view.tone}
      aria-hidden={props.compact ? true : undefined}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-xs",
        TEXT_CLASS[view.tone],
        props.className,
      )}
    >
      <PhaseSteps view={view} />
      {props.compact ? null : (
        <span className="whitespace-nowrap" data-task-phase-label="">
          {view.text}
        </span>
      )}
    </span>
  );
}

/** The badge for a task reference, with Ready read from its lead's live state. */
export function LiveTaskPhaseBadge(props: {
  environmentId: EnvironmentId | null;
  task: ProjectTaskReference;
  compact?: boolean | undefined;
  className?: string | undefined;
}) {
  const status = useLiveTaskStatus(props.environmentId, props.task);
  return (
    <TaskPhaseBadge
      view={taskPhaseView({ ...props.task, status: status.status })}
      compact={props.compact}
      className={props.className}
    />
  );
}
