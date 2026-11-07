import {
  type EnvironmentId,
  formatTaskKey,
  type ProjectId,
  type ProjectTaskId,
  type ProjectTaskReference,
  type ProjectTeamAttentionSummary,
} from "@t3tools/contracts";

/** A task with what it takes to name and open it from anywhere: its key and project. */
export interface RelatedTask {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** Such as BU-55. */
  readonly key: string;
  readonly task: ProjectTaskReference;
}

export interface SubtaskProgress {
  readonly done: number;
  readonly total: number;
}

/** How a task sits among others, Linear-style. Links may cross projects. */
export interface TaskRelations {
  readonly parent: RelatedTask | null;
  /** Unfinished tasks this one waits on. Non-empty means the task is blocked. */
  readonly blockedBy: ReadonlyArray<RelatedTask>;
  /** Unfinished tasks that wait on this one, while this one is unfinished. */
  readonly blocking: ReadonlyArray<RelatedTask>;
  /** Finished waits-on links in either direction; like Linear, they move to Related. */
  readonly related: ReadonlyArray<RelatedTask>;
  /** In number order, cancelled ones left out. */
  readonly subtasks: ReadonlyArray<RelatedTask>;
  /** Null when the task has no subtasks. */
  readonly progress: SubtaskProgress | null;
}

export interface TaskRelationsIndex {
  readonly byId: ReadonlyMap<string, RelatedTask>;
  readonly childrenOf: ReadonlyMap<string, ReadonlyArray<RelatedTask>>;
  readonly waitersOf: ReadonlyMap<string, ReadonlyArray<RelatedTask>>;
}

/** Task IDs are unique per environment; links never cross environments. */
function indexKey(environmentId: EnvironmentId, taskId: ProjectTaskId): string {
  return `${environmentId}\u0000${taskId}`;
}

export function isFinishedTask(task: Pick<ProjectTaskReference, "stage">): boolean {
  return task.stage === "done" || task.stage === "cancelled";
}

const EMPTY_RELATIONS: TaskRelations = {
  parent: null,
  blockedBy: [],
  blocking: [],
  related: [],
  subtasks: [],
  progress: null,
};

/** Every task across every project manager, keyed for relation lookups. */
export function buildTaskRelationsIndex(
  entries: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly summary: Pick<ProjectTeamAttentionSummary, "projectId" | "taskKeyPrefix" | "tasks">;
  }>,
): TaskRelationsIndex {
  const byId = new Map<string, RelatedTask>();
  for (const { environmentId, summary } of entries) {
    for (const task of summary.tasks) {
      byId.set(indexKey(environmentId, task.id), {
        environmentId,
        projectId: summary.projectId,
        key: formatTaskKey(summary.taskKeyPrefix, task.number),
        task,
      });
    }
  }
  const childrenOf = new Map<string, RelatedTask[]>();
  const waitersOf = new Map<string, RelatedTask[]>();
  const push = (map: Map<string, RelatedTask[]>, key: string, value: RelatedTask) => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [value]);
    else list.push(value);
  };
  for (const related of byId.values()) {
    const { environmentId, task } = related;
    if (task.parentTaskId !== null) {
      push(childrenOf, indexKey(environmentId, task.parentTaskId), related);
    }
    for (const waitsOn of task.waitsOn) push(waitersOf, indexKey(environmentId, waitsOn), related);
  }
  for (const list of childrenOf.values()) list.sort(byNumber);
  for (const list of waitersOf.values()) list.sort(byNumber);
  return { byId, childrenOf, waitersOf };
}

function byNumber(a: RelatedTask, b: RelatedTask): number {
  return a.projectId === b.projectId
    ? a.task.number - b.task.number
    : a.key.localeCompare(b.key, undefined, { numeric: true });
}

/** One task with its key, such as BU-55; null when the app doesn't know it. */
export function relatedTask(
  index: TaskRelationsIndex,
  environmentId: EnvironmentId,
  taskId: ProjectTaskId,
): RelatedTask | null {
  return index.byId.get(indexKey(environmentId, taskId)) ?? null;
}

/** A task's parent, blockers, blocked tasks and subtasks. Unknown IDs are left out. */
export function taskRelations(
  index: TaskRelationsIndex,
  environmentId: EnvironmentId,
  taskId: ProjectTaskId,
): TaskRelations {
  const self = index.byId.get(indexKey(environmentId, taskId));
  if (self === undefined) return EMPTY_RELATIONS;
  const { task } = self;
  const parent =
    task.parentTaskId === null
      ? null
      : (index.byId.get(indexKey(environmentId, task.parentTaskId)) ?? null);
  const waitsOn = task.waitsOn
    .map((id) => index.byId.get(indexKey(environmentId, id)))
    .filter((related) => related !== undefined);
  const waiters = index.waitersOf.get(indexKey(environmentId, taskId)) ?? [];
  const selfFinished = isFinishedTask(task);
  // A finished task no longer blocks anyone, and a finished one blocks nobody either way.
  const blockedBy = selfFinished ? [] : waitsOn.filter((related) => !isFinishedTask(related.task));
  const blocking = selfFinished ? [] : waiters.filter((related) => !isFinishedTask(related.task));
  const related = [
    ...waitsOn.filter((other) => !blockedBy.includes(other)),
    ...waiters.filter((other) => !blocking.includes(other)),
  ].filter(
    (other, position, all) => all.findIndex((same) => same.task.id === other.task.id) === position,
  );
  const subtasks = (index.childrenOf.get(indexKey(environmentId, taskId)) ?? []).filter(
    (child) => child.task.stage !== "cancelled",
  );
  return {
    parent,
    blockedBy,
    blocking,
    related,
    subtasks,
    progress:
      subtasks.length === 0
        ? null
        : {
            done: subtasks.filter((child) => child.task.stage === "done").length,
            total: subtasks.length,
          },
  };
}

/** "Blocked by BU-55 · Dependency model" or "Blocked by BU-55, BU-58". */
export function blockedByLabel(blockedBy: ReadonlyArray<RelatedTask>): string {
  const [first] = blockedBy;
  if (first === undefined) return "";
  if (blockedBy.length === 1) return `Blocked by ${first.key} · ${first.task.title}`;
  return `Blocked by ${blockedBy.map((related) => related.key).join(", ")}`;
}

/** "Blocked by BU-55" or "Blocked by 2 tasks", short enough for a phone row. */
export function blockedByShortLabel(blockedBy: ReadonlyArray<RelatedTask>): string {
  const [first] = blockedBy;
  if (first === undefined) return "";
  return blockedBy.length === 1
    ? `Blocked by ${first.key}`
    : `Blocked by ${blockedBy.length} tasks`;
}
