import { useAtomCommand } from "../state/use-atom-command";
import type { EnvironmentId, OrchestrationProjectShell } from "@t3tools/contracts";

import { newProjectId } from "../lib/utils";
import { projectEnvironment } from "../state/projects";

/**
 * Adds a removed project's folder again. The server brings back the same project
 * and the threads its removal archived.
 */
export function useRestoreRemovedProject() {
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  return (project: OrchestrationProjectShell & { readonly environmentId: EnvironmentId }) =>
    createProject({
      environmentId: project.environmentId,
      input: {
        projectId: newProjectId(),
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        createWorkspaceRootIfMissing: false,
        defaultModelSelection: null,
      },
    });
}
