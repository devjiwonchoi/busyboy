/**
 * The one chat screen's view of the work: the toast's work list, the action cards in the chat,
 * and each project's status for @ mentions. It reads BusyBoy tasks and cards from the attention
 * stream, and skill-based work from the node graph adapter, into one shape the screens read.
 */
import {
  type GraphNode,
  type NodeGraph,
  PLAN_APPROVAL_START,
  type ProjectAttentionItem,
  type ProjectDecisionCard,
  type ProjectTaskReference,
  type ProjectTeamAttentionSummary,
} from "@t3tools/contracts";

import { parseRequestOption } from "./requestMessage.js";

/** One project as the screen reads it: its name plus the attention summary. */
export interface OneChatProject {
  readonly projectId: string;
  readonly name: string;
  readonly summary: ProjectTeamAttentionSummary;
}

export type WorkState = "waiting_on_me" | "running";

export interface WorkItem {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  /** The BusyBoy task; null for skill-based work read from the node graph. */
  readonly taskId: string | null;
  /** The node graph node; null for BusyBoy tasks. */
  readonly nodeId: string | null;
  readonly title: string;
  readonly state: WorkState;
  /** The BusyBoy task stage; null for node graph work. */
  readonly stage: ProjectTaskReference["stage"] | null;
  /** Short plain line for the row, such as "Waiting for agreement" or "1 of 3 proven". */
  readonly statusLabel: string;
  /** Where the work is: Align, Build or Review. */
  readonly phaseLabel: string;
  readonly provenCount: number;
  readonly criteriaCount: number;
  /** The open card that makes this item wait on the user, if any. */
  readonly cardId: string | null;
  readonly childIds: ReadonlyArray<string>;
  readonly waitsOnIds: ReadonlyArray<string>;
  readonly prUrl: string | null;
}

export interface WorkCounts {
  readonly waitingOnMe: number;
  readonly running: number;
}

export type ActionCardKind = "plan" | "decision" | "blocker" | "result";

export interface ActionCardOption {
  /** What is sent back when picked. */
  readonly value: string;
  readonly label: string;
  readonly recommended: boolean;
}

export interface ActionCard {
  readonly id: string;
  readonly kind: ActionCardKind;
  readonly projectId: string;
  readonly projectName: string;
  readonly taskId: string | null;
  readonly taskTitle: string;
  /** One line. */
  readonly question: string;
  /** One gray line. */
  readonly subline: string;
  readonly options: ReadonlyArray<ActionCardOption>;
  /** Plan cards show these under the gray line; empty for other kinds. */
  readonly criteria: ReadonlyArray<string>;
  /** Set once answered: only the picked option stays. */
  readonly answered: { readonly label: string; readonly at: string | null } | null;
  readonly createdAt: string;
  /** The server item to answer; null for result cards the screen makes itself. */
  readonly attentionItemId: string | null;
  /**
   * The project the server keeps the card under, which is where the answer goes. A Director
   * card shows under the project of its task but is answered on the Director's project.
   */
  readonly attentionProjectId: string | null;
  readonly prUrl: string | null;
  /** The full question and details for the modal. */
  readonly detailParagraphs: ReadonlyArray<string>;
  readonly details: ReadonlyArray<{ readonly label: string; readonly text: string }>;
  readonly goal: string | null;
  readonly verification: string | null;
}

export interface ProjectMentionStatus {
  readonly projectId: string;
  readonly name: string;
  readonly waitingOnMe: number;
  readonly running: number;
  /** "Waiting on you N · Running M", "Running M", "Waiting on you N", or "Quiet". */
  readonly label: string;
}

const LIVE_STAGES: ReadonlySet<ProjectTaskReference["stage"]> = new Set([
  "planning",
  "awaiting_approval",
  "running",
  "in_review",
  "blocked",
]);

export const RESULT_APPROVE_LABEL = "Looks good, merge";
export const RESULT_FIX_LABEL = "Fix it";
export const PLAN_AGREE_LABEL = "Agree";
export const PLAN_CHANGE_LABEL = "Change";

/** True while the card still needs an answer and the user has not set it aside. */
export function isOpenAttention(item: ProjectAttentionItem): boolean {
  return item.answer === null && item.supersededAt === null && !item.snoozedAt;
}

function isUserProject(project: OneChatProject): boolean {
  return project.summary.kind !== "director";
}

/**
 * The Director's own questions are stored under the Director's project but point at a task in
 * a user project. They show under that project, or under the Director when the task is unknown.
 */
function directorCards(
  projects: ReadonlyArray<OneChatProject>,
): Array<{ project: OneChatProject; card: ProjectDecisionCard }> {
  const cards: Array<{ project: OneChatProject; card: ProjectDecisionCard }> = [];
  for (const director of projects) {
    if (isUserProject(director)) continue;
    for (const card of director.summary.decisionCards) {
      const owner =
        projects.find(
          (project) =>
            isUserProject(project) &&
            project.summary.tasks.some((task) => task.id === card.item.taskId),
        ) ?? director;
      cards.push({ project: owner, card });
    }
  }
  return cards;
}

function proven(task: ProjectTaskReference): { proven: number; total: number } {
  const checks = task.checks ?? [];
  return { proven: checks.filter((check) => check.passed).length, total: checks.length };
}

/** A task in review that passed the Ready gate waits on the user to confirm the result. */
export function needsResultConfirmation(task: ProjectTaskReference): boolean {
  return task.stage === "in_review" && task.ready === true;
}

/** Work the agent cannot move on its own; it waits on the user rather than counting as a failure. */
function isStuck(task: ProjectTaskReference): boolean {
  return task.stage === "blocked" || task.lastOutcome === "stalled" || task.lastOutcome === "failed";
}

function phaseLabel(stage: ProjectTaskReference["stage"]): string {
  switch (stage) {
    case "planning":
    case "awaiting_approval":
      return "Align";
    case "running":
    case "blocked":
      return "Build";
    case "in_review":
      return "Review";
    default:
      return "";
  }
}

function openCardForTask(
  summary: ProjectTeamAttentionSummary,
  taskId: string,
): ProjectDecisionCard | undefined {
  return summary.decisionCards.find(
    (card) => card.item.taskId === taskId && isOpenAttention(card.item),
  );
}

function statusLabel(
  task: ProjectTaskReference,
  card: ProjectDecisionCard | undefined,
  counts: { proven: number; total: number },
): string {
  if (card?.item.kind === "approval") return "Waiting for agreement";
  if (card) return card.item.kind === "blocker" ? "Blocked" : "Waiting for your answer";
  if (needsResultConfirmation(task)) return "Waiting for result check";
  if (isStuck(task)) return "Stuck";
  if (counts.total > 0) return `${counts.proven} of ${counts.total} proven`;
  return phaseLabel(task.stage) ? `${phaseLabel(task.stage)} in progress` : "";
}

/**
 * The toast's rows: work waiting on the user first, then work in progress. BusyBoy tasks come
 * from the attention stream; skill-based work comes from the node graph when it is given.
 */
export function buildWorkItems(
  projects: ReadonlyArray<OneChatProject>,
  graph: NodeGraph | null = null,
  taskWorktrees: ReadonlyArray<string> = [],
): WorkItem[] {
  const items: WorkItem[] = graph ? buildGraphWorkItems(graph, projects, taskWorktrees) : [];
  for (const { project, card } of directorCards(projects)) {
    if (!isOpenAttention(card.item)) continue;
    items.push({
      id: `work:${card.item.id}`,
      projectId: project.projectId,
      projectName: project.name,
      taskId: card.item.taskId,
      nodeId: null,
      title: card.taskTitle || firstLine(card.item.question),
      state: "waiting_on_me",
      stage: null,
      statusLabel: "Waiting for your answer",
      phaseLabel: "",
      provenCount: 0,
      criteriaCount: 0,
      cardId: card.item.id,
      childIds: [],
      waitsOnIds: [],
      prUrl: null,
    });
  }
  for (const project of projects) {
    if (!isUserProject(project)) continue;
    const { summary } = project;
    for (const task of summary.tasks) {
      if (!LIVE_STAGES.has(task.stage)) continue;
      const card = openCardForTask(summary, task.id);
      const counts = proven(task);
      const waiting =
        card !== undefined ||
        task.openQuestion ||
        task.openBlocker ||
        needsResultConfirmation(task) ||
        isStuck(task);
      items.push({
        id: `work:${task.id}`,
        projectId: project.projectId,
        projectName: project.name,
        taskId: task.id,
        nodeId: null,
        title: task.title,
        state: waiting ? "waiting_on_me" : "running",
        stage: task.stage,
        statusLabel: statusLabel(task, card, counts),
        phaseLabel: phaseLabel(task.stage),
        provenCount: counts.proven,
        criteriaCount: counts.total,
        cardId: card ? card.item.id : needsResultConfirmation(task) ? resultCardId(task.id) : null,
        childIds: summary.tasks
          .filter((child) => child.parentTaskId === task.id)
          .map((child) => child.id),
        waitsOnIds: task.waitsOn,
        prUrl: task.prUrl,
      });
    }
  }
  const rank = (item: WorkItem) => (item.state === "waiting_on_me" ? 0 : 1);
  return items.toSorted((a, b) => rank(a) - rank(b));
}

/** Node states that still need the user or are still moving. */
const LIVE_NODE_STATES: ReadonlySet<GraphNode["status"]["state"]> = new Set([
  "draft",
  "running",
  "asking",
  "review",
  "failed",
]);

function nodePhaseLabel(state: GraphNode["status"]["state"]): string {
  switch (state) {
    case "draft":
      return "Align";
    case "running":
    case "asking":
    case "failed":
      return "Build";
    case "review":
      return "Review";
    default:
      return "";
  }
}

function nodeStatusLabel(node: GraphNode): string {
  const { status } = node;
  if (status.dots.ask || status.state === "asking") return "Waiting for your answer";
  if (status.state === "failed" || status.dots.failed) return "Stuck";
  if (status.state === "draft") return "Waiting for agreement";
  if (status.progress && status.progress.total > 0) {
    return `${status.progress.proven} of ${status.progress.total} proven`;
  }
  const phase = nodePhaseLabel(status.state);
  return phase ? `${phase} in progress` : "";
}

/**
 * Worktrees of live BusyBoy tasks, read from their lead threads. A skill record inside one of
 * them is the same work as the task, so the node graph does not count it again.
 */
export function taskWorktreePaths(
  projects: ReadonlyArray<OneChatProject>,
  threads: ReadonlyArray<{ readonly id: string; readonly worktreePath: string | null }>,
): string[] {
  const worktrees = new Map(threads.map((thread) => [thread.id, thread.worktreePath]));
  const paths: string[] = [];
  for (const project of projects) {
    for (const task of project.summary.tasks) {
      if (!LIVE_STAGES.has(task.stage) || task.leadThreadId === null) continue;
      const path = worktrees.get(task.leadThreadId);
      if (path) paths.push(path);
    }
  }
  return paths;
}

function insideAny(path: string, roots: ReadonlyArray<string>): boolean {
  return roots.some((root) => path.startsWith(root.endsWith("/") ? root : `${root}/`));
}

/**
 * Skill-based work from the node graph adapter. A node needs the user when it asks a question,
 * failed (failures are not counted apart), or is still a draft waiting for agreement. Nodes
 * recorded inside a live task's worktree are skipped; the task already has a row.
 */
export function buildGraphWorkItems(
  graph: NodeGraph,
  projects: ReadonlyArray<OneChatProject>,
  taskWorktrees: ReadonlyArray<string> = [],
): WorkItem[] {
  const names = new Map(projects.map((project) => [project.projectId, project.name]));
  const items: WorkItem[] = [];
  for (const node of graph.nodes) {
    if (!LIVE_NODE_STATES.has(node.status.state)) continue;
    if (insideAny(node.recordPath, taskWorktrees)) continue;
    const { status, contract } = node;
    const waiting =
      status.dots.ask ||
      status.dots.failed ||
      status.state === "asking" ||
      status.state === "failed" ||
      status.state === "draft";
    items.push({
      id: `node:${node.id}`,
      projectId: node.projectId ?? "",
      projectName: (node.projectId && names.get(node.projectId)) || "",
      taskId: null,
      nodeId: node.id,
      title: contract?.title ?? node.id,
      state: waiting ? "waiting_on_me" : "running",
      stage: null,
      statusLabel: nodeStatusLabel(node),
      phaseLabel: nodePhaseLabel(status.state),
      provenCount: status.progress?.proven ?? 0,
      criteriaCount: status.progress?.total ?? 0,
      cardId: null,
      childIds: graph.nodes
        .filter((child) => child.contract?.parent === node.id)
        .map((child) => child.id),
      waitsOnIds: [...new Set((contract?.waitsOn ?? []).map((wait) => wait.node))],
      prUrl: null,
    });
  }
  return items;
}

/** A node's agreed end state for the detail modal, in the order the modal shows it. */
export interface NodeEndState {
  readonly title: string;
  readonly purpose: string | null;
  readonly criteria: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly how: string | null;
    readonly status: "pending" | "proven" | "failed";
  }>;
  readonly dont: ReadonlyArray<string>;
  readonly expectedFiles: ReadonlyArray<{ readonly path: string; readonly change: string | null }>;
  /** Parts of the record that could not be read; shown, never hidden. */
  readonly issues: ReadonlyArray<string>;
}

export function nodeEndState(node: GraphNode): NodeEndState {
  const results = new Map(node.status.criteria.map((result) => [result.id, result.status]));
  return {
    title: node.contract?.title ?? node.id,
    purpose: node.contract?.purpose ?? null,
    criteria: (node.contract?.criteria ?? []).map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      how: criterion.how,
      status: results.get(criterion.id) ?? "pending",
    })),
    dont: node.contract?.dont ?? [],
    expectedFiles: node.contract?.expectedFiles ?? [],
    issues: node.issues.map((issue) => `${issue.file}: ${issue.message}`),
  };
}

export function workCounts(items: ReadonlyArray<WorkItem>): WorkCounts {
  let waitingOnMe = 0;
  let running = 0;
  for (const item of items) {
    if (item.state === "waiting_on_me") waitingOnMe += 1;
    else running += 1;
  }
  return { waitingOnMe, running };
}

/** The toast disappears when nothing waits on the user and nothing runs. */
export function isToastVisible(counts: WorkCounts): boolean {
  return counts.waitingOnMe > 0 || counts.running > 0;
}

export function resultCardId(taskId: string): string {
  return `result:${taskId}`;
}

function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim().length > 0) ?? "").trim();
}

function restParagraphs(text: string): string[] {
  const [, ...rest] = text.split(/\n\s*\n/);
  return rest.map((paragraph) => paragraph.trim()).filter(Boolean);
}

function cardKind(item: ProjectAttentionItem): ActionCardKind {
  if (item.kind === "approval") return "plan";
  return item.kind === "blocker" ? "blocker" : "decision";
}

function serverCardOptions(item: ProjectAttentionItem): ActionCardOption[] {
  if (item.kind === "approval") {
    return [
      { value: PLAN_APPROVAL_START, label: PLAN_AGREE_LABEL, recommended: true },
      { value: PLAN_CHANGE_LABEL, label: PLAN_CHANGE_LABEL, recommended: false },
    ];
  }
  const options = item.options.map((raw) => {
    const parsed = parseRequestOption(raw);
    return { value: raw, label: parsed.label, recommended: parsed.recommended };
  });
  if (options.length > 0 && !options.some((option) => option.recommended)) {
    options[0] = { ...options[0]!, recommended: true };
  }
  return options;
}

function answeredLabel(item: ProjectAttentionItem, options: ReadonlyArray<ActionCardOption>) {
  if (item.answer === null) return null;
  if (item.kind === "approval") {
    return item.answer.split("\n")[0] === PLAN_APPROVAL_START ? PLAN_AGREE_LABEL : PLAN_CHANGE_LABEL;
  }
  const firstAnswerLine = item.answer.split("\n")[0] ?? item.answer;
  return options.find((option) => option.value === firstAnswerLine)?.label ?? firstAnswerLine;
}

function serverCard(project: OneChatProject, card: ProjectDecisionCard): ActionCard {
  const { item } = card;
  const options = serverCardOptions(item);
  const task = item.taskId
    ? project.summary.tasks.find((candidate) => candidate.id === item.taskId)
    : undefined;
  const paragraphs = restParagraphs(item.question);
  const answered = answeredLabel(item, options);
  return {
    id: item.id,
    kind: cardKind(item),
    projectId: project.projectId,
    projectName: project.name,
    taskId: item.taskId,
    taskTitle: card.taskTitle,
    question: firstLine(item.question),
    subline: firstLine(paragraphs[0] ?? item.summary ?? card.plan?.summary ?? ""),
    options,
    criteria: item.kind === "approval" ? (task?.checks ?? []).map((check) => check.text) : [],
    answered: answered === null ? null : { label: answered, at: item.answeredAt },
    createdAt: item.createdAt,
    attentionItemId: item.id,
    attentionProjectId: item.projectId,
    prUrl: task?.prUrl ?? null,
    detailParagraphs: paragraphs,
    details: item.details ?? [],
    goal: item.summary,
    verification: item.verification,
  };
}

function resultCard(project: OneChatProject, task: ProjectTaskReference): ActionCard {
  const counts = proven(task);
  const subline = [
    counts.total > 0 ? `${counts.proven} of ${counts.total} criteria proven` : null,
    task.prUrl ? "PR open" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const done = task.stage === "done";
  return {
    id: resultCardId(task.id),
    kind: "result",
    projectId: project.projectId,
    projectName: project.name,
    taskId: task.id,
    taskTitle: task.title,
    question: `${task.title}: check the result?`,
    subline,
    options: [
      { value: RESULT_APPROVE_LABEL, label: RESULT_APPROVE_LABEL, recommended: true },
      { value: RESULT_FIX_LABEL, label: RESULT_FIX_LABEL, recommended: false },
    ],
    criteria: [],
    answered: done ? { label: RESULT_APPROVE_LABEL, at: task.updatedAt } : null,
    createdAt: task.updatedAt ?? "1970-01-01T00:00:00.000Z",
    attentionItemId: null,
    attentionProjectId: null,
    prUrl: task.prUrl,
    detailParagraphs: [],
    details: (task.checks ?? []).map((check) => ({
      label: check.passed ? "Proven" : "Not yet",
      text: check.text,
    })),
    goal: null,
    verification: null,
  };
}

/**
 * Every project's cards for the chat, oldest first: open and recently answered server cards,
 * plus a result card for each task that is ready for the user to confirm. A result card
 * collapses on its own once its task is done.
 */
export function buildActionCards(projects: ReadonlyArray<OneChatProject>): ActionCard[] {
  const cards: ActionCard[] = [];
  for (const project of projects) {
    if (!isUserProject(project)) continue;
    for (const card of project.summary.decisionCards) {
      if (card.item.supersededAt !== null || card.item.snoozedAt) continue;
      cards.push(serverCard(project, card));
    }
    for (const task of project.summary.tasks) {
      if (needsResultConfirmation(task) || (task.stage === "done" && task.ready === true)) {
        cards.push(resultCard(project, task));
      }
    }
  }
  for (const { project, card } of directorCards(projects)) {
    if (card.item.supersededAt !== null || card.item.snoozedAt) continue;
    cards.push(serverCard(project, card));
  }
  return cards.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Each project's status for the @ mention list. */
export function projectMentionStatus(
  projects: ReadonlyArray<OneChatProject>,
  graph: NodeGraph | null = null,
  taskWorktrees: ReadonlyArray<string> = [],
): ProjectMentionStatus[] {
  const items = buildWorkItems(projects, graph, taskWorktrees);
  return projects.filter(isUserProject).map((project) => {
    const counts = workCounts(items.filter((item) => item.projectId === project.projectId));
    const parts = [
      counts.waitingOnMe > 0 ? `Waiting on you ${counts.waitingOnMe}` : null,
      counts.running > 0 ? `Running ${counts.running}` : null,
    ].filter(Boolean);
    return {
      projectId: project.projectId,
      name: project.name,
      waitingOnMe: counts.waitingOnMe,
      running: counts.running,
      label: parts.length > 0 ? parts.join(" · ") : "Quiet",
    };
  });
}

/** How a project is written after @: its name with spaces turned into dashes. */
export function projectMentionHandle(name: string): string {
  return name.trim().replace(/\s+/g, "-");
}

/** What "Looks good, merge" sends to the Director. It asks; it never merges by itself. */
export function resultMergeRequestMessage(card: ActionCard): string {
  return `@${projectMentionHandle(card.projectName)} ${card.taskTitle}: I checked the result. Please merge it.`;
}

/** What "Fix it" puts in the composer for the user to finish. */
export function resultFixMessage(card: ActionCard): string {
  return `@${projectMentionHandle(card.projectName)} ${card.taskTitle}: please fix `;
}

/** A side chat reply quoted into the main composer. */
export function quoteForComposer(text: string): string {
  const quoted = text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${quoted}\n\n`;
}

/** The @ query at the caret, or null when the caret is not in an @ mention. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  return { start: caret - match[1]!.length - 1, query: match[1]! };
}

/** True when the composer text is the side chat command. */
export function isSideChatCommand(text: string): boolean {
  return /^\/side\s*$/.test(text.trim());
}
