import { orderProjectsForSidebar, pinScratchProjectGroupLast } from "../components/Sidebar.logic";
import { getProjectOrderKey, selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import {
  useEnvironmentIdentities,
  useEnvironmentIds,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { useProjects } from "../state/entities";
import { useDirectorProjectKeys } from "../state/director";
import { useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";

/**
 * Project groups in the user's manual order, with "No project" last. The
 * Director's hidden system project is left out: it has its own rail entry.
 */
export function useSidebarProjectGroups() {
  const directorKeys = useDirectorProjectKeys(useEnvironmentIds());
  const projects = useProjects().filter(
    (project) => !directorKeys.has(`${project.environmentId}:${project.id}`),
  );
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const environments = useEnvironmentIdentities();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const labels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  return pinScratchProjectGroupLast(
    buildSidebarProjectSnapshots({
      projects: orderProjectsForSidebar(projects, projectOrder, getProjectOrderKey),
      groupScratchProjects: true,
      settings: groupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => labels.get(environmentId) ?? null,
    }),
  );
}
