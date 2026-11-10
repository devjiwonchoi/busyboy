import { waitingItemKeys } from "@t3tools/shared/waitingAlerts";
import type { ProjectManagerEntry } from "~/state/projectTeam";
import { isDirectorSummary, isOpenDecisionCard } from "~/state/projectTeam.logic";

/** Derive every surface from the same open attention items, including the Director. */
export function directorInbox(entries: readonly ProjectManagerEntry[]) {
  const groups = entries
    .flatMap(({ environmentId, summary }) => {
      const cards = summary.decisionCards
        .filter(isOpenDecisionCard)
        .toSorted((a, b) => Date.parse(a.item.createdAt) - Date.parse(b.item.createdAt));
      const total = cards.length + summary.waitingThreads.length;
      if (total === 0) {
        return [];
      }
      return [
        {
          environmentId,
          projectId: summary.projectId,
          pmThreadId: summary.pmThreadId,
          pmName: summary.persona.name,
          isDirector: isDirectorSummary(summary),
          taskKeyPrefix: summary.taskKeyPrefix,
          cards,
          waitingThreads: summary.waitingThreads,
          oldestAt: cards[0]?.item.createdAt ?? null,
          total,
        },
      ];
    })
    .toSorted(
      (a, b) =>
        (a.oldestAt === null ? Infinity : Date.parse(a.oldestAt)) -
        (b.oldestAt === null ? Infinity : Date.parse(b.oldestAt)),
    );
  return { groups, total: waitingItemKeys(entries).total };
}

export type DirectorInboxGroup = ReturnType<typeof directorInbox>["groups"][number];
