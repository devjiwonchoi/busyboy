import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  formatTaskKey,
  type EnvironmentId,
  type ProjectDecisionCard,
  type ProjectTeamAttentionSummary,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { useEnvironmentIds } from "~/state/environments";
import { useProjectManagerEntries } from "~/state/projectTeam";
import { taskRouteParams } from "~/taskRoutes";
import { DecisionCard } from "../chat/DecisionCard";

const isOpenCard = (card: ProjectDecisionCard) =>
  card.item.answeredAt === null && card.item.supersededAt === null;

/** How many questions and approvals wait on the user across these projects. */
export function countWaitingOnYou(
  summaries: ReadonlyArray<Pick<ProjectTeamAttentionSummary, "decisionCards">>,
): number {
  return summaries.reduce(
    (count, summary) => count + summary.decisionCards.filter(isOpenCard).length,
    0,
  );
}

interface CardEntry {
  readonly environmentId: EnvironmentId;
  readonly summary: ProjectTeamAttentionSummary;
  readonly card: ProjectDecisionCard;
}

interface TaskGroup {
  readonly key: string;
  readonly entries: CardEntry[];
}

/** Open cards grouped by task, oldest question first within and across groups. */
function groupByTask(entries: ReadonlyArray<CardEntry>): ReadonlyArray<TaskGroup> {
  const groups = new Map<string, CardEntry[]>();
  for (const entry of entries.toSorted(
    (a, b) => Date.parse(a.card.item.createdAt) - Date.parse(b.card.item.createdAt),
  )) {
    const key = `${entry.environmentId}:${entry.card.item.taskId}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups].map(([key, groupEntries]) => ({ key, entries: groupEntries }));
}

function DecisionCardFor(props: { entry: CardEntry }) {
  const { environmentId, summary, card } = props.entry;
  return (
    <DecisionCard
      card={card}
      environmentId={environmentId}
      threadRef={scopeThreadRef(environmentId, summary.pmThreadId)}
      cwd={undefined}
    />
  );
}

/**
 * Every question and plan approval the user's tasks are waiting on, in one
 * place, grouped by task. Answers go straight to the task's agent.
 */
export function WaitingOnYouPage() {
  const entries = useProjectManagerEntries(useEnvironmentIds());
  const all: CardEntry[] = entries.flatMap(({ environmentId, summary }) =>
    summary.decisionCards.map((card) => ({ environmentId, summary, card })),
  );
  const open = groupByTask(all.filter((entry) => isOpenCard(entry.card)));
  const closed = all
    .filter((entry) => !isOpenCard(entry.card))
    .toSorted(
      (a, b) =>
        Date.parse(b.card.item.answeredAt ?? b.card.item.supersededAt ?? b.card.item.createdAt) -
        Date.parse(a.card.item.answeredAt ?? a.card.item.supersededAt ?? a.card.item.createdAt),
    );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="waiting-on-you">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
        <header className="flex flex-col gap-1">
          <h1 className="font-semibold text-lg">Waiting on you</h1>
          <p className="text-muted-foreground text-sm">
            Questions and plan approvals from your tasks. Answers go straight to the task's agent.
          </p>
        </header>

        {open.length === 0 ? (
          <p
            data-testid="waiting-on-you-empty"
            className="rounded-lg border border-dashed px-4 py-6 text-center text-muted-foreground text-sm"
          >
            Nothing is waiting on you.
          </p>
        ) : (
          <div className="flex flex-col gap-4" data-testid="waiting-on-you-open">
            {open.map((group) => {
              const { environmentId, summary, card } = group.entries[0]!;
              const taskKey = formatTaskKey(summary.taskKeyPrefix, card.taskNumber);
              return (
                <section
                  key={group.key}
                  data-task-group={taskKey}
                  className="flex flex-col gap-2 rounded-lg border bg-card p-4"
                >
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 font-mono text-muted-foreground text-xs">
                      {taskKey}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium text-sm">
                      {card.taskTitle}
                    </span>
                    <Link
                      {...taskRouteParams(environmentId, summary.projectId, card.item.taskId)}
                      className="shrink-0 text-primary text-xs hover:underline"
                    >
                      Open task
                    </Link>
                  </div>
                  {group.entries.map((entry) => (
                    <DecisionCardFor key={entry.card.item.id} entry={entry} />
                  ))}
                </section>
              );
            })}
          </div>
        )}

        {closed.length > 0 ? (
          <details data-testid="waiting-on-you-closed" className="group flex flex-col gap-2">
            <summary className="cursor-pointer text-muted-foreground text-sm select-none">
              Recently answered ({closed.length})
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              {closed.map((entry) => (
                <DecisionCardFor key={entry.card.item.id} entry={entry} />
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}
