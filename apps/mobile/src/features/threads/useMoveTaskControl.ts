import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ExecutionLocation,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";

import { environmentPresentations } from "../../state/presentation";
import { useLeadThreadTask, useMoveTask } from "../../state/projectTeam";
import { showGitActionResult } from "../../state/use-vcs-action-state";
import type { MoveTaskControlProps } from "./MoveTaskButton";

/** The move button's state for a task lead's thread, or null for any other thread. */
export function useMoveTaskControl(
  thread: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly id: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
  } | null,
): MoveTaskControlProps | null {
  const task = useLeadThreadTask(thread);
  const moveTask = useMoveTask();
  const [requested, setRequested] = useState<ExecutionLocation | null>(null);
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  if (thread === null || task === null) return null;
  // Unknown until providers load; the server still refuses non-Claude leads.
  const leadDriver = providersByEnvironment
    .get(thread.environmentId)
    ?.find((provider) => provider.instanceId === thread.providerInstanceId)?.driver;
  const disabledReason =
    task.stage === "done" || task.stage === "cancelled"
      ? "끝난 태스크는 옮길 수 없어요"
      : leadDriver !== undefined && leadDriver !== "claudeAgent"
        ? "Claude 리드만 옮길 수 있어요"
        : null;
  return {
    location: task.location ?? "local",
    movingTo: task.moveTarget ?? requested,
    disabledReason,
    onMove: (to) => {
      setRequested(to);
      void moveTask(thread.environmentId, {
        projectId: thread.projectId,
        taskId: task.id,
        to,
      }).then((result) => {
        setRequested(null);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          showGitActionResult({
            type: "error",
            title: to === "cloud" ? "클라우드로 옮기지 못했어요" : "로컬로 가져오지 못했어요",
            ...(error instanceof Error ? { description: error.message } : {}),
          });
        }
      });
    },
    onExplainDisabled: (reason) =>
      showGitActionResult({ type: "error", title: "옮길 수 없어요", description: reason }),
  };
}
