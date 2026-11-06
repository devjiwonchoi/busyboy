import {
  type EnvironmentId,
  type ProjectTaskReference,
  type ProjectTaskStatus,
  type ProjectTaskStatusSignals,
  resolveProjectTaskStatus,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { useThreadShell } from "~/state/entities";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";
import { describeTaskStatus, type SidebarRowStatus } from "../sidebar/SidebarRowLine";

type TaskStatusInput = Pick<
  ProjectTaskReference,
  "stage" | "prUrl" | "lastOutcome" | "openQuestion"
>;

/** A task's status signals from its card state and its lead thread's live state. */
export function taskStatusSignals(
  task: Pick<ProjectTaskReference, "openQuestion">,
  leadStatus: SidebarThreadStatus | null,
): ProjectTaskStatusSignals {
  return {
    // A tool approval or input request in the lead's thread waits on the user too.
    openQuestion: task.openQuestion || leadStatus === "approval" || leadStatus === "input",
    leadRunning: leadStatus === "working",
    leadFailed: leadStatus === "failed",
  };
}

export interface LiveTaskStatus extends SidebarRowStatus {
  readonly status: ProjectTaskStatus;
}

/** The status, label and icon for a task, given its lead thread's live state. */
export function resolveLiveTaskStatus(
  task: TaskStatusInput,
  leadStatus: SidebarThreadStatus | null,
): LiveTaskStatus {
  const status = resolveProjectTaskStatus(task, taskStatusSignals(task, leadStatus));
  return { ...describeTaskStatus(status, task), status };
}

/** A task's user-facing status, kept live by its lead thread's state. */
export function useLiveTaskStatus(
  environmentId: EnvironmentId | null,
  task: TaskStatusInput & Pick<ProjectTaskReference, "leadThreadId">,
): LiveTaskStatus {
  const lead = useThreadShell(
    environmentId === null || task.leadThreadId === null
      ? null
      : scopeThreadRef(environmentId, task.leadThreadId),
  );
  return resolveLiveTaskStatus(task, lead === null ? null : resolveSidebarThreadStatus(lead));
}
