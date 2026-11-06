import type {
  EnvironmentId,
  ProjectTaskId,
  ProjectTaskReference,
  ProjectTeamAttentionSummary,
} from "@t3tools/contracts";

export interface AllProjectsTaskRow {
  readonly task: ProjectTaskReference;
  readonly depth: number;
}

export interface AllProjectsSection {
  readonly environmentId: EnvironmentId;
  readonly summary: ProjectTeamAttentionSummary;
  readonly rows: ReadonlyArray<AllProjectsTaskRow>;
  readonly openCount: number;
  readonly doneCount: number;
  /** The newest task update, used to put active projects first. */
  readonly latestUpdate: string | null;
}

/** Done and cancelled tasks are archived: hidden unless the user asks for them. */
export function isArchivedTask(task: Pick<ProjectTaskReference, "stage">): boolean {
  return task.stage === "done" || task.stage === "cancelled";
}

function newer(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/**
 * A project's task rows: newest task first, each subtask right under its parent
 * (oldest first). A subtask whose parent is hidden shows as a top-level row.
 */
export function allProjectsTaskRows(
  tasks: ReadonlyArray<ProjectTaskReference>,
  showDone: boolean,
): ReadonlyArray<AllProjectsTaskRow> {
  const shown = showDone ? tasks : tasks.filter((task) => !isArchivedTask(task));
  const ids = new Set(shown.map((task) => task.id));
  const childrenOf = new Map<ProjectTaskId, ProjectTaskReference[]>();
  const roots: ProjectTaskReference[] = [];
  for (const task of shown.toSorted((a, b) => a.number - b.number)) {
    if (task.parentTaskId !== null && ids.has(task.parentTaskId)) {
      childrenOf.set(task.parentTaskId, [...(childrenOf.get(task.parentTaskId) ?? []), task]);
    } else {
      roots.push(task);
    }
  }
  const rows: AllProjectsTaskRow[] = [];
  const visit = (task: ProjectTaskReference, depth: number) => {
    rows.push({ task, depth });
    for (const child of childrenOf.get(task.id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots.toReversed()) visit(root, 0);
  return rows;
}

/** One section per project manager, most recently active project first. */
export function buildAllProjectsSections(
  entries: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly summary: ProjectTeamAttentionSummary;
  }>,
  showDone: boolean,
): ReadonlyArray<AllProjectsSection> {
  return entries
    .map(({ environmentId, summary }) => {
      const doneCount = summary.tasks.filter(isArchivedTask).length;
      return {
        environmentId,
        summary,
        rows: allProjectsTaskRows(summary.tasks, showDone),
        openCount: summary.tasks.length - doneCount,
        doneCount,
        latestUpdate: summary.tasks.reduce<string | null>(
          (latest, task) => newer(latest, task.updatedAt),
          null,
        ),
      };
    })
    .toSorted((a, b) => {
      if (a.latestUpdate !== b.latestUpdate) {
        if (a.latestUpdate === null) return 1;
        if (b.latestUpdate === null) return -1;
        return a.latestUpdate > b.latestUpdate ? -1 : 1;
      }
      return 0;
    });
}
