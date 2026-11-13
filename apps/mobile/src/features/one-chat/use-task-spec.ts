import type { EnvironmentId, ProjectId, ProjectTaskId } from "@t3tools/contracts";

import { projectTeamEnvironment } from "../../state/projectTeam";
import { useEnvironmentQuery } from "../../state/query";

/** The current written spec of a task, read lazily; null until it loads or when there is none. */
export function useTaskSpec(
  environmentId: EnvironmentId | null,
  projectId: string,
  taskId: string | null,
  enabled: boolean,
) {
  const detail = useEnvironmentQuery(
    enabled && environmentId !== null && taskId !== null
      ? projectTeamEnvironment.taskDetail({
          environmentId,
          input: { projectId: projectId as ProjectId, taskId: taskId as ProjectTaskId },
        })
      : null,
  );
  return detail.data?.versions.at(-1)?.spec ?? null;
}
