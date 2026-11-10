import type {
  ProjectDecisionCard,
  ProjectTeamAttentionSummary,
  ThreadId,
} from "@t3tools/contracts";
import { requestSenderLabel, shortWorkName } from "@t3tools/shared/requestMessage";

/** An open card shown in a PM or Director thread, with the project it belongs to. */
export interface ThreadTeamCard {
  readonly card: ProjectDecisionCard;
  /** "Blocker · Jota · busyboy" */
  readonly header: string;
  readonly sender: string;
  readonly leadThreadId: ThreadId | null;
  /** Only the request's own PM chat ties a reply to it, so 답장 shows only there. */
  readonly replyable: boolean;
}

const KIND_LABEL: Record<ProjectDecisionCard["item"]["kind"], string> = {
  decision: "Decision",
  approval: "Plan approval",
  blocker: "Blocker",
};

/** Answered and superseded requests no longer need a reply. */
const isOpenAnswerableCard = (card: ProjectDecisionCard) =>
  card.item.answeredAt === null && card.item.supersededAt === null;

/**
 * Open requests for a thread: a PM chat shows its project's cards, the
 * Director's chat shows every project's, oldest first. Other threads show none.
 */
export function openTeamCardsForThread(
  summaries: ReadonlyArray<
    Pick<
      ProjectTeamAttentionSummary,
      "projectId" | "pmThreadId" | "kind" | "decisionCards" | "tasks"
    >
  >,
  threadId: ThreadId,
  projectTitleOf: (projectId: ProjectDecisionCard["item"]["projectId"]) => string,
): ReadonlyArray<ThreadTeamCard> {
  const own = summaries.find((summary) => summary.pmThreadId === threadId);
  if (own === undefined) {
    return [];
  }
  const shown = own.kind === "director" ? summaries : [own];
  // A Director card sits in the Director's project but is about a task in another one.
  const taskProjects = new Map(
    summaries.flatMap((summary) => summary.tasks.map((task) => [task.id, summary.projectId])),
  );
  const projectOf = (card: ProjectDecisionCard) =>
    (card.item.taskId === null ? undefined : taskProjects.get(card.item.taskId)) ??
    card.item.projectId;
  return shown
    .flatMap((summary) => summary.decisionCards.filter(isOpenAnswerableCard))
    .toSorted((a, b) => Date.parse(a.item.createdAt) - Date.parse(b.item.createdAt))
    .map((card) => {
      const task = summaries
        .flatMap((summary) => summary.tasks)
        .find((task) => task.id === card.item.taskId);
      const leadThreadId = task?.leadThreadId ?? null;
      const projectTitle = projectTitleOf(projectOf(card));
      return {
        card,
        header: `${KIND_LABEL[card.item.kind]} · ${card.taskTitle} · ${projectTitle}`,
        sender: requestSenderLabel({
          role: card.item.senderRole ?? (leadThreadId === null ? "pm" : "lead"),
          name: card.item.senderName ?? shortWorkName(card.taskTitle),
          projectTitle,
        })!,
        leadThreadId,
        replyable:
          summaries.find((summary) => summary.projectId === card.item.projectId)?.pmThreadId ===
          threadId,
      };
    });
}

/** The card's first line as its title, the rest as detail. */
export function splitCardQuestion(question: string): { title: string; detail: string } {
  const [first = "", ...rest] = question.trim().split("\n");
  return { title: first.trim(), detail: rest.join("\n").trim() };
}

/** "Label: tradeoff (Recommended)" shows as "Label"; the answer keeps the full text. */
export function cardOptionLabel(option: string): string {
  const clean = option.replace(/\((?:recommended|추천)\)/gi, "").trim();
  const separator = / [—–] |:\s+/.exec(clean);
  return separator !== null && separator.index <= 80
    ? clean.slice(0, separator.index).trim()
    : clean;
}

/** Keep completion criteria and dependency ids out of the visible numbered plan. */
export function requestTodoRows(card: ProjectDecisionCard) {
  const todos = card.plan?.todos ?? [];
  return todos.map((todo, index) => ({
    id: todo.id,
    text: todo.text,
    done: todo.done,
    detail: [
      todo.doneWhen,
      ...todo.dependsOn.flatMap((id) => {
        const dependency = todos.findIndex((candidate) => candidate.id === id);
        return dependency < 0 ? [] : [`${dependency + 1} 다음`];
      }),
    ]
      .filter(Boolean)
      .join(" · "),
    number: index + 1,
  }));
}
