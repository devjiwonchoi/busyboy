import type { ProjectTaskFile, ProjectTaskFileChange } from "@t3tools/contracts";

/** What a plan todo needs for the todo list and the breakdown graph. */
export interface PlanTodoLike {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly doneWhen: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly subtaskId?: string | null;
}

export type PlanTodoStatus = "done" | "current" | "todo";

/**
 * Each todo's status. While work runs, the first open todo whose dependencies are all done is
 * the current one; before approval nothing is current.
 */
export function planTodoStatuses(
  todos: ReadonlyArray<PlanTodoLike>,
  running: boolean,
): ReadonlyArray<PlanTodoStatus> {
  const done = new Set(todos.filter((todo) => todo.done).map((todo) => todo.id));
  const known = new Set(todos.map((todo) => todo.id));
  let currentTaken = !running;
  return todos.map((todo) => {
    if (todo.done) return "done";
    if (currentTaken) return "todo";
    const ready = todo.dependsOn.every((id) => done.has(id) || !known.has(id));
    if (!ready) return "todo";
    currentTaken = true;
    return "current";
  });
}

/** Step numbers (1-based) of the todos this one comes after, skipping unknown ids. */
export function planTodoDependencyNumbers(
  todos: ReadonlyArray<PlanTodoLike>,
  todo: PlanTodoLike,
): ReadonlyArray<number> {
  const numbers: number[] = [];
  for (const id of todo.dependsOn) {
    const index = todos.findIndex((candidate) => candidate.id === id);
    if (index >= 0) numbers.push(index + 1);
  }
  return numbers.toSorted((a, b) => a - b);
}

/** "2 steps · 1 done". */
export function planProgressLabel(todos: ReadonlyArray<Pick<PlanTodoLike, "done">>): string {
  const done = todos.filter((todo) => todo.done).length;
  return `${todos.length} ${todos.length === 1 ? "step" : "steps"} · ${done} done`;
}

/** Mermaid node text: no quotes or brackets that would break the label, clipped. */
function mermaidLabel(text: string, max = 48): string {
  const clean = text
    .replace(/["[\]{}()<>#;|`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * The breakdown graph as Mermaid: one node per step, an edge from each dependency, done steps
 * and split subtasks styled. Null when there are no steps or no dependencies to draw.
 */
export function planBreakdownMermaid(
  todos: ReadonlyArray<PlanTodoLike>,
  statuses: ReadonlyArray<PlanTodoStatus>,
): string | null {
  if (todos.length === 0) return null;
  const nodeId = new Map(todos.map((todo, index) => [todo.id, `s${index + 1}`]));
  const lines = ["flowchart LR"];
  todos.forEach((todo, index) => {
    const id = nodeId.get(todo.id)!;
    const suffix = todo.subtaskId ? " ↗" : "";
    lines.push(`  ${id}["${index + 1}. ${mermaidLabel(todo.text)}${suffix}"]`);
  });
  let edges = 0;
  for (const todo of todos) {
    for (const dep of todo.dependsOn) {
      const from = nodeId.get(dep);
      if (from === undefined) continue;
      lines.push(`  ${from} --> ${nodeId.get(todo.id)!}`);
      edges += 1;
    }
  }
  if (edges === 0) return null;
  lines.push("  classDef done fill:#16a34a22,stroke:#16a34a;");
  lines.push("  classDef current fill:#3b82f622,stroke:#3b82f6;");
  const doneIds = todos.flatMap((todo, index) =>
    statuses[index] === "done" ? [nodeId.get(todo.id)!] : [],
  );
  const currentIds = todos.flatMap((todo, index) =>
    statuses[index] === "current" ? [nodeId.get(todo.id)!] : [],
  );
  if (doneIds.length > 0) lines.push(`  class ${doneIds.join(",")} done;`);
  if (currentIds.length > 0) lines.push(`  class ${currentIds.join(",")} current;`);
  return lines.join("\n");
}

export interface PlanFileNode {
  readonly kind: "folder" | "file";
  /** Display name; a folder with one child folder is merged into it ("src/components"). */
  readonly name: string;
  /** Full path, unique in the tree. */
  readonly path: string;
  readonly children: ReadonlyArray<PlanFileNode>;
  readonly file: ProjectTaskFile | null;
}

/** The plan's files as a folder tree, folders first, single-child folders merged. */
export function planFileTree(files: ReadonlyArray<ProjectTaskFile>): ReadonlyArray<PlanFileNode> {
  interface Draft {
    folders: Map<string, Draft>;
    files: ProjectTaskFile[];
  }
  const root: Draft = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/").filter((part) => part.length > 0);
    let at = root;
    for (const part of parts.slice(0, -1)) {
      let next = at.folders.get(part);
      if (next === undefined) {
        next = { folders: new Map(), files: [] };
        at.folders.set(part, next);
      }
      at = next;
    }
    at.files.push(file);
  }
  const build = (draft: Draft, prefix: string): PlanFileNode[] => {
    const folders = [...draft.folders.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, child]): PlanFileNode => {
        let label = name;
        let path = prefix === "" ? name : `${prefix}/${name}`;
        let node = child;
        while (node.files.length === 0 && node.folders.size === 1) {
          const [nextName, next] = [...node.folders.entries()][0]!;
          label = `${label}/${nextName}`;
          path = `${path}/${nextName}`;
          node = next;
        }
        return { kind: "folder", name: label, path, children: build(node, path), file: null };
      });
    const leaves = draft.files
      .toSorted((a, b) => a.path.localeCompare(b.path))
      .map((file): PlanFileNode => ({
        kind: "file",
        name: file.path.split("/").at(-1) ?? file.path,
        path: file.path,
        children: [],
        file,
      }));
    return [...folders, ...leaves];
  };
  return build(root, "");
}

export const FILE_CHANGE_LABEL: Record<ProjectTaskFileChange, string> = {
  new: "New",
  changed: "Changed",
  deleted: "Deleted",
};
