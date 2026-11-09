import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ProjectTaskId, ProjectTaskReference } from "@t3tools/contracts";

export type SidebarTaskTreeRow =
  | { kind: "thread"; key: string; depth: number }
  | { kind: "task"; task: ProjectTaskReference; depth: number }
  | {
      kind: "thread-group";
      taskId: ProjectTaskId;
      count: number;
      expanded: boolean;
      depth: number;
    };

export type SidebarTaskToggle = { hasChildren: boolean; expanded: boolean };

/** Resolve launcher ancestry through shells, including ancestors outside the active shelf. */
export function sidebarTaskTree(input: {
  threads: readonly EnvironmentThreadShell[];
  tasks: readonly ProjectTaskReference[];
  taskByLeadKey: ReadonlyMap<string, { taskId: ProjectTaskId }>;
  threadByKey: ReadonlyMap<string, EnvironmentThreadShell>;
  collapsedTaskKeys: ReadonlySet<string>;
  expandedThreadGroupKeys: ReadonlySet<string>;
  environmentId: string;
}) {
  const keyOf = (thread: EnvironmentThreadShell) => `${thread.environmentId}:${thread.id}`;
  const taskKey = (id: ProjectTaskId) => `${input.environmentId}:${id}`;
  const activeKeys = new Set(input.threads.map(keyOf));
  const tasks = input.tasks.filter(
    (task) =>
      task.stage !== "done" &&
      task.stage !== "cancelled" &&
      (task.leadThreadId === null || activeKeys.has(`${input.environmentId}:${task.leadThreadId}`)),
  );
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const children = new Map<ProjectTaskId, ProjectTaskReference[]>();
  for (const task of tasks) {
    if (task.parentTaskId !== null && taskById.has(task.parentTaskId)) {
      const siblings = children.get(task.parentTaskId) ?? [];
      siblings.push(task);
      children.set(task.parentTaskId, siblings);
    }
  }

  // Pick the lowest-numbered ready sibling each time; cycles fall back to number order.
  const orderSiblings = (siblings: readonly ProjectTaskReference[]) => {
    const remaining = siblings.toSorted((a, b) => a.number - b.number);
    const ordered: ProjectTaskReference[] = [];
    while (remaining.length > 0) {
      const ready = remaining.findIndex(
        (task) => !remaining.some((other) => task.waitsOn.includes(other.id)),
      );
      ordered.push(...remaining.splice(ready < 0 ? 0 : ready, 1));
    }
    return ordered;
  };
  const ownerOf = (thread: EnvironmentThreadShell) => {
    // Only launched threads join a group; user-created forks keep their top-level row.
    const launcher =
      thread.launchedByThreadId == null
        ? undefined
        : input.threadByKey.get(`${thread.environmentId}:${thread.launchedByThreadId}`);
    const pending = launcher ? [launcher] : [];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.shift()!;
      const key = keyOf(current);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      const lead = input.taskByLeadKey.get(key);
      if (lead && taskById.has(lead.taskId)) {
        return lead.taskId;
      }
      for (const id of [current.launchedByThreadId, current.lineage.parentThreadId]) {
        if (id == null) {
          continue;
        }
        const ancestor = input.threadByKey.get(`${current.environmentId}:${id}`);
        if (ancestor) {
          pending.push(ancestor);
        }
      }
    }
    return null;
  };
  const grouped = new Map<ProjectTaskId, EnvironmentThreadShell[]>();
  const roots: EnvironmentThreadShell[] = [];
  for (const thread of input.threads) {
    const lead = input.taskByLeadKey.get(keyOf(thread));
    if (lead && taskById.has(lead.taskId)) {
      const parentId = taskById.get(lead.taskId)!.parentTaskId;
      if (parentId === null || !taskById.has(parentId)) {
        roots.push(thread);
      }
      continue;
    }
    const owner = ownerOf(thread);
    if (owner === null) {
      roots.push(thread);
    } else {
      const group = grouped.get(owner) ?? [];
      group.push(thread);
      grouped.set(owner, group);
    }
  }

  const rows: SidebarTaskTreeRow[] = [];
  const toggles = new Map<ProjectTaskId, SidebarTaskToggle>();
  const visitedTasks = new Set<ProjectTaskId>();
  const visit = (task: ProjectTaskReference, depth: number) => {
    if (visitedTasks.has(task.id)) {
      return;
    }
    visitedTasks.add(task.id);
    const subtasks = children.get(task.id) ?? [];
    const expanded = !input.collapsedTaskKeys.has(taskKey(task.id));
    toggles.set(task.id, { hasChildren: subtasks.length > 0, expanded });
    rows.push(
      task.leadThreadId === null
        ? { kind: "task", task, depth }
        : { kind: "thread", key: `${input.environmentId}:${task.leadThreadId}`, depth },
    );
    if (!expanded) {
      return;
    }
    for (const child of orderSiblings(subtasks)) {
      visit(child, depth + 1);
    }
    const group = grouped.get(task.id) ?? [];
    if (group.length > 0) {
      const groupExpanded = input.expandedThreadGroupKeys.has(taskKey(task.id));
      rows.push({
        kind: "thread-group",
        taskId: task.id,
        count: group.length,
        expanded: groupExpanded,
        depth: depth + 1,
      });
      if (groupExpanded) {
        for (const thread of group) {
          rows.push({ kind: "thread", key: keyOf(thread), depth: depth + 2 });
        }
      }
    }
  };

  // Preserve the existing roots: no-session tasks first, then the current thread order.
  for (const task of tasks.toSorted((a, b) => a.number - b.number)) {
    if (
      task.leadThreadId === null &&
      (task.parentTaskId === null || !taskById.has(task.parentTaskId))
    ) {
      visit(task, 0);
    }
  }
  for (const thread of roots) {
    const lead = input.taskByLeadKey.get(keyOf(thread));
    const task = lead ? taskById.get(lead.taskId) : undefined;
    if (task) {
      visit(task, 0);
    } else {
      rows.push({ kind: "thread", key: keyOf(thread), depth: 0 });
    }
  }
  return { rows, toggles };
}
