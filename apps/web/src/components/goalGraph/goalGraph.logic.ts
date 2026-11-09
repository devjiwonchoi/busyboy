import {
  formatTaskKey,
  type ProjectDecisionCard,
  type WorkspaceBlockReason,
} from "@t3tools/contracts";
import { alignWorkspaceGoals } from "@t3tools/shared/workspaceGoals";
import { splitDirectorEntry } from "~/state/projectTeam.logic";
import { type MapEntry, projectKey } from "../allProjects/allProjects.logic";

const DAY = 24 * 60 * 60 * 1000;
const openCard = (card: ProjectDecisionCard) =>
  card.item.answeredAt === null && card.item.supersededAt === null;
const finished = (stage: string) => stage === "done" || stage === "cancelled";
export type TaskTone = "running" | "review" | "ready" | "done" | "blocked" | "planning";
type Progress = { done: number; total: number };

/**
 * "방금 바뀜", "N분 전" or "N시간 전" within the last 24 hours, else null. Times slightly
 * ahead of now count as now: "now" is rounded down to the minute.
 */
export function changedLabel(updatedAt: string | null, nowMs: number): string | null {
  if (updatedAt === null) {
    return null;
  }
  const elapsed = Math.max(0, nowMs - Date.parse(updatedAt));
  if (!Number.isFinite(elapsed) || elapsed >= DAY) {
    return null;
  }
  if (elapsed < 5 * 60 * 1000) {
    return "방금 바뀜";
  }
  if (elapsed < 60 * 60 * 1000) {
    return `${Math.floor(elapsed / 60000)}분 전`;
  }
  return `${Math.floor(elapsed / 3600000)}시간 전`;
}

export function buildGoalGraph(input: {
  entries: ReadonlyArray<MapEntry>;
  projectTitles?: ReadonlyMap<string, string>;
  nowMs: number;
  recentOnly?: boolean | undefined;
}) {
  const { director } = splitDirectorEntry(input.entries);
  const active = (director?.summary.goals ?? [])
    .filter((goal) => goal.status === "active")
    .toSorted((a, b) => a.position - b.position);
  const records = input.entries.flatMap((entry) =>
    entry.summary.tasks.map((task) => ({ ...task, entry, projectId: entry.summary.projectId })),
  );
  const recordKey = (environmentId: string, taskId: string) => `${environmentId}/${taskId}`;
  const byId = new Map(records.map((task) => [recordKey(task.entry.environmentId, task.id), task]));
  const lineage = (task: (typeof records)[number]) => {
    const chain: typeof records = [];
    const seen = new Set<string>();
    let current: typeof task | undefined = task;
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(current);
      current =
        current.parentTaskId === null
          ? undefined
          : byId.get(recordKey(current.entry.environmentId, current.parentTaskId));
    }
    return chain;
  };

  // Recompute from the same task snapshot as the nodes, so stale server alignment cannot hide work.
  const alignments = [...new Set(input.entries.map((entry) => entry.environmentId))].map(
    (environmentId) => ({
      environmentId,
      alignment: alignWorkspaceGoals({
        goals: director?.environmentId === environmentId ? active : [],
        tasks: records.filter((task) => task.entry.environmentId === environmentId),
        projectIds: input.entries
          .filter((entry) => entry.environmentId === environmentId)
          .map((entry) => entry.summary.projectId),
      }),
    }),
  );
  const unaligned = new Set(
    alignments.flatMap(({ environmentId, alignment }) =>
      alignment.unalignedTasks.map((task) => recordKey(environmentId, task.taskId)),
    ),
  );
  const goalIdsOf = (task: (typeof records)[number]): string[] => {
    const alignment = alignments.find(
      (item) => item.environmentId === task.entry.environmentId,
    )!.alignment;
    const ids: string[] = alignment.goals
      .filter((goal) => goal.taskIds.includes(task.id))
      .map((goal) => goal.goalId);
    if (
      ids.length === 0 &&
      lineage(task).some((ancestor) =>
        unaligned.has(recordKey(task.entry.environmentId, ancestor.id)),
      )
    ) {
      ids.push("goal:none");
    }
    return ids;
  };
  const recent = (at: string | null) => changedLabel(at, input.nowMs) !== null;
  const tasks = records
    .filter(
      (task) =>
        task.entry.summary.kind !== "director" &&
        task.stage !== "cancelled" &&
        task.stage !== "proposed" &&
        goalIdsOf(task).length > 0 &&
        (task.stage !== "done" ||
          (recent(task.updatedAt) && !goalIdsOf(task).includes("goal:none"))),
    )
    .map((task) => {
      const cards = task.entry.summary.decisionCards.filter(
        (card) => openCard(card) && card.item.taskId === task.id,
      );
      const dependencies = task.waitsOn
        .map((id) => byId.get(recordKey(task.entry.environmentId, id)))
        .filter((dependency) => dependency !== undefined)
        .filter((dependency) => !finished(dependency.stage));
      const blockReasons: WorkspaceBlockReason[] = [];
      if (task.openBlocker) {
        blockReasons.push("fatal");
      } else if (task.openQuestion || cards.length > 0) {
        blockReasons.push("waiting_on_user");
      }
      if (task.stage === "blocked") {
        blockReasons.push("blocked");
      }
      if (dependencies.length > 0) {
        blockReasons.push("waits_on");
      }
      const tone: TaskTone =
        blockReasons.length > 0
          ? "blocked"
          : task.stage === "in_review"
            ? task.ready
              ? "ready"
              : "review"
            : task.stage === "running"
              ? "running"
              : task.stage === "done"
                ? "done"
                : "planning";
      return {
        id: task.id,
        nodeId: `task:${recordKey(task.entry.environmentId, task.id)}`,
        key: formatTaskKey(task.entry.summary.taskKeyPrefix, task.number),
        title: task.title,
        stage: task.stage,
        tone,
        live:
          task.stage === "running" &&
          !task.openQuestion &&
          !task.openBlocker &&
          task.lastOutcome !== "stalled" &&
          task.lastOutcome !== "failed",
        recent: recent(task.updatedAt),
        updatedAt: task.updatedAt,
        changedLabel: changedLabel(task.updatedAt, input.nowMs),
        waitingCount: Math.max(cards.length, task.openQuestion || task.openBlocker ? 1 : 0),
        blockReasons,
        waitsOnKeys: dependencies.map((dependency) =>
          formatTaskKey(dependency.entry.summary.taskKeyPrefix, dependency.number),
        ),
        dependencyIds: dependencies.map(
          (dependency) => `task:${recordKey(task.entry.environmentId, dependency.id)}`,
        ),
        needsYou: task.openQuestion || task.openBlocker || cards.length > 0,
        /** The open card "나를 기다림" opens; null sends the user to the PM chat. */
        cardId: cards[0]?.item.id ?? null,
        parentId:
          task.parentTaskId === null
            ? null
            : `task:${recordKey(task.entry.environmentId, task.parentTaskId)}`,
        depth: 0,
        goalIds: goalIdsOf(task),
        projectKey: projectKey(task.entry.environmentId, task.projectId),
        environmentId: task.entry.environmentId,
        projectId: task.projectId,
        pmThreadId: task.entry.summary.pmThreadId,
      };
    })
    .filter((task) => !input.recentOnly || task.recent);
  const taskById = new Map(tasks.map((task) => [task.nodeId, task]));
  for (const task of tasks) {
    const seen = new Set([task.nodeId]);
    let parent = task.parentId === null ? undefined : taskById.get(task.parentId);
    while (parent !== undefined && !seen.has(parent.nodeId)) {
      seen.add(parent.nodeId);
      task.depth++;
      parent = parent.parentId === null ? undefined : taskById.get(parent.parentId);
    }
  }
  const progress = (items: ReadonlyArray<{ stage: string }>): Progress => ({
    done: items.filter((task) => task.stage === "done").length,
    total: items.length,
  });
  // Ancestors reflect only the tasks displayed on the board.
  const signals = (shown: typeof tasks) => {
    const newest = shown.toSorted(
      (a, b) =>
        (b.updatedAt === null ? 0 : Date.parse(b.updatedAt)) -
        (a.updatedAt === null ? 0 : Date.parse(a.updatedAt)),
    )[0];
    return {
      live: shown.some((task) => task.live),
      recent: shown.some((task) => task.recent),
      changedLabel: newest?.changedLabel ?? null,
      needsYou: shown.reduce((sum, task) => sum + task.waitingCount, 0),
      waitingTarget: shown.find((task) => task.needsYou) ?? null,
    };
  };
  const goals = active
    .filter((goal) => !input.recentOnly || tasks.some((task) => task.goalIds.includes(goal.id)))
    .map((goal) => {
      const contributing = records.filter(
        (task) => task.entry.summary.kind !== "director" && goalIdsOf(task).includes(goal.id),
      );
      const shown = tasks.filter((task) => task.goalIds.includes(goal.id));
      const proposals = (director?.summary.decisionCards ?? []).filter((card) => {
        if (!openCard(card) || card.item.kind !== "proposal") {
          return false;
        }
        const proposed = byId.get(recordKey(director!.environmentId, card.item.taskId));
        return goal.links.some((link) =>
          link.taskId === null
            ? link.projectId === (card.proposal?.projectId ?? proposed?.projectId)
            : proposed !== undefined &&
              lineage(proposed).some((ancestor) => ancestor.id === link.taskId),
        );
      });
      return {
        id: String(goal.id),
        title: goal.title,
        ...progress(contributing),
        missingWork: alignments.some(({ alignment }) =>
          alignment.goalsWithoutOpenWork.includes(goal.id),
        ),
        blocked: shown.some((task) => task.tone === "blocked"),
        proposals,
        ...signals(shown),
      };
    });
  if (tasks.some((task) => task.goalIds.includes("goal:none"))) {
    const shown = tasks.filter((task) => task.goalIds.includes("goal:none"));
    goals.push({
      id: "goal:none",
      title: "목표 없음",
      ...progress(shown),
      missingWork: false,
      blocked: shown.some((task) => task.tone === "blocked"),
      proposals: [],
      ...signals(shown),
    });
  }
  const projects = input.entries
    .filter(
      (entry) =>
        entry.summary.kind !== "director" &&
        (tasks.some(
          (task) => task.projectKey === projectKey(entry.environmentId, entry.summary.projectId),
        ) ||
          (!input.recentOnly &&
            entry.environmentId === director?.environmentId &&
            active.some((goal) =>
              goal.links.some(
                (link) => link.projectId === entry.summary.projectId && link.taskId === null,
              ),
            ))),
    )
    .map((entry) => {
      const key = projectKey(entry.environmentId, entry.summary.projectId);
      const shown = tasks.filter((task) => task.projectKey === key);
      return {
        key,
        nodeId: `project:${key}`,
        environmentId: entry.environmentId,
        projectId: entry.summary.projectId,
        title: input.projectTitles?.get(key) ?? "프로젝트",
        pmThreadId: entry.summary.pmThreadId,
        progress: progress(shown),
        ...signals(shown),
        // A badge with no waiting task on the board opens the PM chat.
        cardId: null,
        // Unfiltered projects also show manager activity; filtered pulses belong to visible work.
        live:
          (!input.recentOnly && entry.summary.presence.running > 0) ||
          shown.some((task) => task.live),
        blocked: shown.some((task) => task.tone === "blocked"),
      };
    });
  const edges: {
    id: string;
    from: string;
    to: string;
    kind: "goal-project" | "project-task" | "parent" | "waits";
    blocked: boolean;
  }[] = [];
  const edge = (from: string, to: string, kind: (typeof edges)[number]["kind"], blocked: boolean) =>
    edges.push({ id: `${kind}:${from}:${to}`, from, to, kind, blocked });
  for (const goal of goals) {
    for (const project of projects) {
      const contributing = tasks.filter(
        (task) => task.projectKey === project.key && task.goalIds.includes(goal.id),
      );
      const linked =
        active
          .find((item) => item.id === goal.id)
          ?.links.some((link) => link.projectId === project.projectId && link.taskId === null) &&
        project.environmentId === director?.environmentId;
      const alignedProject = alignments
        .find((item) => item.environmentId === project.environmentId)
        ?.alignment.goals.find((item) => item.goalId === goal.id)
        ?.projectIds.includes(project.projectId);
      if (contributing.length > 0 || (!input.recentOnly && (linked || alignedProject))) {
        edge(
          goal.id,
          project.nodeId,
          "goal-project",
          contributing.some((task) => task.tone === "blocked"),
        );
      }
    }
  }
  for (const task of tasks) {
    edge(`project:${task.projectKey}`, task.nodeId, "project-task", task.tone === "blocked");
    if (task.parentId !== null && taskById.has(task.parentId)) {
      edge(task.parentId, task.nodeId, "parent", false);
    }
    for (const dependency of task.dependencyIds) {
      if (taskById.has(dependency)) {
        edge(task.nodeId, dependency, "waits", true);
      }
    }
  }
  projects.sort(
    (a, b) =>
      goals.findIndex((goal) =>
        edges.some((item) => item.from === goal.id && item.to === a.nodeId),
      ) -
      goals.findIndex((goal) =>
        edges.some((item) => item.from === goal.id && item.to === b.nodeId),
      ),
  );
  return {
    goals,
    projects,
    tasks,
    edges,
    director,
    directorBriefing: director?.summary.briefing?.trim() || null,
    briefing: {
      goals: goals
        .filter((goal) => goal.id !== "goal:none")
        .map(({ id, title, done, total }) => ({ id, title, done, total })),
      blockedCount: tasks.filter((task) => task.tone === "blocked").length,
      needsYouCount: tasks.filter((task) => task.needsYou).length,
      firstBlockedNodeId: tasks.find((task) => task.tone === "blocked")?.nodeId ?? null,
      firstNeedsYouNodeId: tasks.find((task) => task.needsYou)?.nodeId ?? null,
    },
  };
}

export type GoalGraphData = ReturnType<typeof buildGoalGraph>;
export type NodeBox = { id: string; x: number; y: number; width: number; height: number };

/** Tasks in depth-first order, so each subtask sits right under its parent. */
export function treeOrder<T extends GoalGraphData["tasks"][number]>(
  tasks: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const ordered: T[] = [];
  const visited = new Set<string>();
  const visit = (task: T) => {
    if (visited.has(task.nodeId)) {
      return;
    }
    visited.add(task.nodeId);
    ordered.push(task);
    tasks.filter((child) => child.parentId === task.nodeId).forEach(visit);
  };
  tasks.filter((task) => !tasks.some((parent) => parent.nodeId === task.parentId)).forEach(visit);
  tasks.forEach(visit);
  return ordered;
}

export function layoutGoalGraph(graph: GoalGraphData) {
  const boxes: NodeBox[] = [];
  let cursor = 16;
  for (const project of graph.projects) {
    const ordered = treeOrder(graph.tasks.filter((task) => task.projectKey === project.key));
    const height = Math.max(68, ordered.length * 56 - 12);
    boxes.push({
      id: project.nodeId,
      x: 320,
      y: cursor + (height - 68) / 2,
      width: 240,
      height: 68,
    });
    ordered.forEach((task, index) =>
      boxes.push({
        id: task.nodeId,
        x: 640 + task.depth * 16,
        y: cursor + index * 56,
        width: 300,
        height: 44,
      }),
    );
    cursor += height + 24;
  }
  let bottom = 16;
  for (const goal of graph.goals) {
    const related = boxes.filter((box) =>
      graph.edges.some(
        (edge) => edge.kind === "goal-project" && edge.from === goal.id && edge.to === box.id,
      ),
    );
    const center =
      related.length === 0
        ? bottom + 38
        : related.reduce((sum, box) => sum + box.y + box.height / 2, 0) / related.length;
    const y = Math.max(bottom, center - 38);
    boxes.push({ id: goal.id, x: 0, y, width: 240, height: 76 });
    bottom = y + 88;
  }
  const width = Math.max(960, ...boxes.map((box) => box.x + box.width + 80));
  const height = Math.max(180, ...boxes.map((box) => box.y + box.height + 16));
  const paths = graph.edges.map((edge) => {
    const from = boxes.find((box) => box.id === edge.from)!;
    const to = boxes.find((box) => box.id === edge.to)!;
    const x = from.x + from.width;
    const y = from.y + from.height / 2;
    const ty = to.y + to.height / 2;
    const loop = edge.kind === "parent" || edge.kind === "waits";
    const tx = loop ? to.x + to.width : to.x;
    const bend = loop ? Math.max(x, tx) + 48 : (x + tx) / 2;
    return { ...edge, d: `M${x},${y} C${bend},${y} ${bend},${ty} ${tx},${ty}` };
  });
  return { boxes, width, height, paths };
}

export function relatedNodeIds(graph: GoalGraphData, nodeId: string) {
  // A goal or task only lights up its own goals' paths, not every goal through a shared project.
  const task = graph.tasks.find((node) => node.nodeId === nodeId);
  const scope: ReadonlySet<string> | null = graph.goals.some((goal) => goal.id === nodeId)
    ? new Set([nodeId])
    : task !== undefined
      ? new Set(task.goalIds)
      : null;
  const inScope = (edge: GoalGraphData["edges"][number]) => {
    if (scope === null) {
      return true;
    }
    if (edge.kind === "goal-project") {
      return scope.has(edge.from);
    }
    if (edge.kind === "project-task") {
      const target = graph.tasks.find((node) => node.nodeId === edge.to);
      return target?.goalIds.some((id) => scope.has(id)) ?? false;
    }
    return true;
  };
  const result = new Set([nodeId]);
  // Traverse each direction independently; siblings are not ancestors or descendants.
  for (const forward of [true, false]) {
    const visited = new Set([nodeId]);
    const queue = [nodeId];
    for (const id of queue) {
      for (const edge of graph.edges) {
        if ((forward ? edge.from : edge.to) !== id || !inScope(edge)) {
          continue;
        }
        const next = forward ? edge.to : edge.from;
        if (!visited.has(next)) {
          visited.add(next);
          result.add(next);
          queue.push(next);
        }
      }
    }
  }
  return result;
}
