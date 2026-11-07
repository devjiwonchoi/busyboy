import {
  type EnvironmentId,
  PROJECT_TASK_MODEL_ROLES,
  type ProjectTaskMetrics,
  type ProjectTaskModelRole,
  type ProjectTaskModelSteps,
  type ProjectTaskStepUsages,
} from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import { useRoleModelLabel } from "./RoleModelPicker";
import { stepUsageParts, taskUsageTotal } from "./taskUsage.logic";

/** Role names beside the phase badge (계획 → 구현·리뷰 → 배포). */
export const TASK_MODEL_ROLE_LABELS: Record<ProjectTaskModelRole, string> = {
  plan: "계획",
  implement: "구현",
  review: "리뷰",
  fix: "수정",
};

/**
 * The model that last ran each role, one chip per role that ran, with what the role spent
 * once a run finished: "리뷰 · Opus 5.5 · 3m ×2 · 410k/12k · $1.40". With `metrics`, a line
 * below sums the task.
 */
export function TaskModelSteps(props: {
  environmentId: EnvironmentId;
  steps: ProjectTaskModelSteps;
  usage?: ProjectTaskStepUsages | undefined;
  metrics?: ProjectTaskMetrics | undefined;
  className?: string | undefined;
}) {
  const label = useRoleModelLabel(props.environmentId);
  const ran = PROJECT_TASK_MODEL_ROLES.flatMap((role) => {
    const step = props.steps[role];
    return step === undefined ? [] : [{ role, step }];
  });
  if (ran.length === 0) return null;
  const total =
    props.metrics === undefined ? null : taskUsageTotal(props.usage ?? {}, props.metrics);
  const chips = (
    <span
      data-task-model-steps=""
      className={cn("flex min-w-0 flex-wrap items-center gap-1", props.className)}
    >
      {ran.map(({ role, step }) => (
        <span
          key={role}
          data-model-step={role}
          title={step.model ?? undefined}
          className="max-w-full truncate whitespace-nowrap rounded-full border border-border/70 px-1.5 text-[11px] text-muted-foreground leading-4"
        >
          {[TASK_MODEL_ROLE_LABELS[role], label(step), ...stepUsageParts(props.usage?.[role])].join(
            " · ",
          )}
        </span>
      ))}
    </span>
  );
  if (total === null) return chips;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {chips}
      <p data-task-usage-total="" className="text-[11px] text-muted-foreground leading-4">
        {total}
      </p>
    </div>
  );
}
