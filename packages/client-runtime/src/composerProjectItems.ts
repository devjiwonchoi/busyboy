import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

const COMPOSER_PROJECT_RESULT_LIMIT = 8;

export interface ComposerProjectCandidate {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly isScratch?: true;
}

export interface ComposerProjectItem {
  readonly id: string;
  readonly type: "project";
  readonly project: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
  };
  readonly label: string;
  readonly description: string;
}

/**
 * Projects lead the `@` menu, even before a query is typed, because a workspace has only a
 * handful of them. Names that start with the query rank ahead of names that only contain it.
 */
export function matchComposerProjectItems(input: {
  projects: ReadonlyArray<ComposerProjectCandidate>;
  environmentId: EnvironmentId;
  query: string;
}): ComposerProjectItem[] {
  const query = input.query.trim().toLowerCase();
  const rank = (title: string) => (title.toLowerCase().startsWith(query) ? 0 : 1);
  return input.projects
    .filter(
      (project) =>
        project.environmentId === input.environmentId &&
        project.isScratch !== true &&
        project.title.toLowerCase().includes(query),
    )
    .sort(
      (left, right) =>
        rank(left.title) - rank(right.title) || left.title.localeCompare(right.title),
    )
    .slice(0, COMPOSER_PROJECT_RESULT_LIMIT)
    .map((project) => ({
      id: `project:${project.environmentId}:${project.id}`,
      type: "project",
      project: {
        environmentId: project.environmentId,
        projectId: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
      },
      label: project.title,
      description: project.workspaceRoot,
    }));
}
