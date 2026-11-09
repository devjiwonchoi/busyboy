import { orderProjectsForSidebar, pinScratchProjectGroupLast } from "../components/Sidebar.logic";
import { getProjectOrderKey, selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import {
  useEnvironmentIdentities,
  useEnvironmentIds,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { useProjects } from "../state/entities";
import { useDirector } from "../state/director";
import { useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";

/** Project groups follow manual order, with a new Director first and scratch last. */
export function useSidebarProjectGroups() {
  const director = useDirector(useEnvironmentIds());
  const projects = useProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const environments = useEnvironmentIdentities();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const labels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const directorProject = projects.find(
    (project) =>
      project.environmentId === director?.environmentId &&
      project.id === director.summary.projectId,
  );
  const directorOrderKey = directorProject ? getProjectOrderKey(directorProject) : null;
  // The Director's folder can sit inside a checkout (a dev baseDir); it must stay its own
  // group, never a member of that repository's project.
  const groupedProjects = !directorProject?.repositoryIdentity
    ? projects
    : projects.map((project) =>
        project === directorProject ? { ...project, repositoryIdentity: null } : project,
      );
  const order =
    directorOrderKey !== null && !projectOrder.includes(directorOrderKey)
      ? [directorOrderKey, ...projectOrder]
      : projectOrder;
  return pinScratchProjectGroupLast(
    buildSidebarProjectSnapshots({
      projects: orderProjectsForSidebar(groupedProjects, order, getProjectOrderKey),
      groupScratchProjects: true,
      settings: groupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => labels.get(environmentId) ?? null,
    }),
  );
}
