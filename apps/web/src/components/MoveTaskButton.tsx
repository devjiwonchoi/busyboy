import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ExecutionLocation,
  ProjectId,
  ProjectTaskId,
  ProjectTaskStage,
  ThreadId,
} from "@t3tools/contracts";
import { CloudUploadIcon, LaptopIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "../state/entities";
import { useEnvironmentProviders } from "../state/environments";
import { useMoveTask } from "../state/projectTeam";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const MOVE_LABEL: Record<ExecutionLocation, string> = {
  cloud: "클라우드로 옮기기",
  local: "로컬로 가져오기",
};
const MOVING_LABEL: Record<ExecutionLocation, string> = {
  cloud: "클라우드로 옮기는 중…",
  local: "로컬로 가져오는 중…",
};
const MOVE_HINT: Record<ExecutionLocation, string> = {
  cloud: "리드를 클라우드 샌드박스로 옮겨요",
  local: "리드를 이 Mac으로 가져와요",
};

export interface MoveTaskControlProps {
  readonly location: ExecutionLocation;
  /** Where the lead is going while a move runs; null otherwise. */
  readonly movingTo: ExecutionLocation | null;
  /** Why the move can't start; null when it can. */
  readonly disabledReason: string | null;
  readonly onMove: (to: ExecutionLocation) => void;
  readonly className?: string | undefined;
}

/** The button itself: one move toward the other place, or a quiet pill while the lead moves. */
export function MoveTaskControl(props: MoveTaskControlProps) {
  if (props.movingTo !== null) {
    return (
      <span
        data-move-task="moving"
        className={cn(
          "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-border/70 px-1.5 py-0.5 text-muted-foreground text-xs",
          props.className,
        )}
      >
        <Spinner size="xs" aria-hidden role="presentation" />
        {MOVING_LABEL[props.movingTo]}
      </span>
    );
  }
  const to: ExecutionLocation = props.location === "cloud" ? "local" : "cloud";
  const Icon = to === "cloud" ? CloudUploadIcon : LaptopIcon;
  const disabled = props.disabledReason !== null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn("inline-flex shrink-0", props.className)} />}>
        <button
          type="button"
          data-move-task={to}
          disabled={disabled}
          onClick={() => props.onMove(to)}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 font-normal text-muted-foreground text-xs transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground"
        >
          <Icon aria-hidden className="size-3.5" />
          {MOVE_LABEL[to]}
        </button>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.disabledReason ?? MOVE_HINT[to]}</TooltipPopup>
    </Tooltip>
  );
}

export interface MoveTaskButtonProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly task: {
    readonly id: ProjectTaskId;
    readonly stage: ProjectTaskStage;
    readonly leadThreadId: ThreadId | null;
    readonly location?: ExecutionLocation | undefined;
    readonly moveTarget?: ExecutionLocation | null | undefined;
  };
  readonly className?: string | undefined;
}

/** Moves a task's lead between the Mac and a cloud sandbox with one click. */
export function MoveTaskButton(props: MoveTaskButtonProps) {
  const { environmentId, projectId, task } = props;
  const moveTask = useMoveTask();
  const [requested, setRequested] = useState<ExecutionLocation | null>(null);
  const leadShell = useThreadShell(
    task.leadThreadId === null ? null : scopeThreadRef(environmentId, task.leadThreadId),
  );
  const providers = useEnvironmentProviders().get(environmentId);
  // Unknown until the shell and providers load; the server still refuses non-Claude leads.
  const leadDriver =
    leadShell === null
      ? undefined
      : providers?.find((provider) => provider.instanceId === leadShell.providerInstanceId)?.driver;

  const disabledReason =
    task.stage === "done" || task.stage === "cancelled"
      ? "끝난 태스크는 옮길 수 없어요"
      : task.leadThreadId === null
        ? "리드가 아직 시작하지 않았어요"
        : leadDriver !== undefined && leadDriver !== "claudeAgent"
          ? "Claude 리드만 옮길 수 있어요"
          : null;

  const move = (to: ExecutionLocation) => {
    setRequested(to);
    void moveTask(environmentId, { projectId, taskId: task.id, to }).then((result) => {
      setRequested(null);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: to === "cloud" ? "클라우드로 옮기지 못했어요" : "로컬로 가져오지 못했어요",
          description: error instanceof Error ? error.message : undefined,
        });
      }
    });
  };

  return (
    <MoveTaskControl
      location={task.location ?? "local"}
      movingTo={task.moveTarget ?? requested}
      disabledReason={disabledReason}
      onMove={move}
      className={props.className}
    />
  );
}
