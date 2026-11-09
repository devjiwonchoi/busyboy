import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useDirectorInbox } from "~/state/director";
import { pendingActionItems } from "~/state/projectTeam.logic";
import { buildThreadRouteParams } from "~/threadRoutes";
import { DecisionCard } from "../chat/DecisionCard";
import { InboxTaskLink, useDirectorInboxTitles } from "./DirectorInbox";

/** One shared decision at a time, kept beside the Director's composer. */
export function DirectorInboxDock() {
  const { groups } = useDirectorInbox();
  const titleOf = useDirectorInboxTitles();
  const navigate = useNavigate();
  // The shown item and its sort time; when it closes, the next item in time takes its place.
  const [selection, setSelection] = useState({ id: null as string | null, at: -Infinity });
  // Flatten before sorting: cards from different projects can interleave in time.
  const items = groups
    .filter((group) => !group.isDirector)
    .flatMap((group) => [
      ...group.cards.map((card) => ({
        id: `${group.environmentId}:card:${card.item.id}`,
        at: Date.parse(card.item.createdAt),
        group,
        card,
        thread: null,
      })),
      ...group.waitingThreads.map((thread) => ({
        id: `${group.environmentId}:thread:${thread.threadId}`,
        at: Infinity,
        group,
        card: null,
        thread,
      })),
    ])
    .toSorted((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1));
  const followedIndex = items.findIndex((item) => item.id === selection.id);
  const nextInTime = items.findIndex((item) => item.at >= selection.at);
  const index =
    followedIndex >= 0
      ? followedIndex
      : nextInTime >= 0
        ? nextInTime
        : Math.max(0, items.length - 1);
  const current = items[index];
  const select = (target: number) => {
    const item = items[target];
    if (item) setSelection({ id: item.id, at: item.at });
  };
  if (!current) {
    return null;
  }
  const { group, card, thread } = current;
  return (
    <section
      aria-label="받은편지함"
      data-director-inbox
      className="mb-2 max-h-[40dvh] min-w-0 overflow-y-auto rounded-lg border bg-background p-2"
    >
      <header className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">
          받은편지함 {index + 1}/{items.length}
        </span>
        <span
          data-director-inbox-project={group.projectId}
          className="min-w-0 truncate rounded-full bg-muted px-2 py-0.5"
        >
          {card !== null ? <InboxTaskLink card={card} group={group} /> : titleOf(group)}
        </span>
        <div className="ml-auto flex gap-1">
          <button
            type="button"
            aria-label="이전 카드"
            disabled={index === 0}
            onClick={() => select(index - 1)}
            className="rounded px-2 py-1 hover:bg-muted disabled:opacity-40"
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="다음 카드"
            disabled={index === items.length - 1}
            onClick={() => select(index + 1)}
            className="rounded px-2 py-1 hover:bg-muted disabled:opacity-40"
          >
            ›
          </button>
        </div>
      </header>
      {card !== null ? (
        <DecisionCard
          key={`${group.environmentId}:${card.item.id}`}
          card={card}
          environmentId={group.environmentId}
          threadRef={scopeThreadRef(group.environmentId, group.pmThreadId)}
          cwd={undefined}
        />
      ) : thread !== null ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1">
            {pendingActionItems({ cards: [], waitingThreads: [thread] })[0]?.label}
          </span>
          <button
            type="button"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(
                  scopeThreadRef(group.environmentId, thread.threadId),
                ),
              })
            }
            className="rounded px-2 py-1 hover:bg-muted"
          >
            열기
          </button>
        </div>
      ) : null}
    </section>
  );
}
