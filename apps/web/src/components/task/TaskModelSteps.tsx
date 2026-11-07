import {
  type EnvironmentId,
  PROJECT_TASK_MODEL_ROLES,
  type ProjectTaskModelRole,
  type ProjectTaskModelSteps,
} from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import { useRoleModelLabel } from "./RoleModelPicker";

/** Role names beside the phase badge (계획 → 구현·리뷰 → 배포). */
export const TASK_MODEL_ROLE_LABELS: Record<ProjectTaskModelRole, string> = {
  plan: "계획",
  implement: "구현",
  review: "리뷰",
  fix: "수정",
};

/** The model that last ran each role, one chip per role that ran: "구현 · GPT-5.5". */
export function TaskModelSteps(props: {
  environmentId: EnvironmentId;
  steps: ProjectTaskModelSteps;
  className?: string | undefined;
}) {
  const label = useRoleModelLabel(props.environmentId);
  const ran = PROJECT_TASK_MODEL_ROLES.flatMap((role) => {
    const step = props.steps[role];
    return step === undefined ? [] : [{ role, step }];
  });
  if (ran.length === 0) return null;
  return (
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
          {`${TASK_MODEL_ROLE_LABELS[role]} · ${label(step)}`}
        </span>
      ))}
    </span>
  );
}
