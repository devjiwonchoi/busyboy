import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ProjectDecisionCard, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useDirectorInbox } from "~/state/director";
import { pendingActionItems } from "~/state/projectTeam.logic";
import { buildThreadRouteParams } from "~/threadRoutes";
import { pendingActionsBannerItem } from "../chat/PendingActionsBar";
import { DirectorInboxDialog, useDirectorInboxTitles } from "./DirectorInbox";
import { useDirectorChat } from "./useDirectorChat";

/** Share Director bar routing with its dialog while keeping ordinary chat reveal unchanged. */
export function useDirectorPendingActions(input: {
  threadRef: ScopedThreadRef | null;
  cards: readonly ProjectDecisionCard[];
  onRevealCard: (cardId: string) => void;
}) {
  const director = useDirectorChat();
  const inbox = useDirectorInbox();
  const titleOf = useDirectorInboxTitles();
  const navigate = useNavigate();
  const [cardId, setCardId] = useState<string | null>(null);
  const isDirectorThread =
    director !== null &&
    input.threadRef?.environmentId === director.threadRef.environmentId &&
    input.threadRef.threadId === director.threadRef.threadId;

  // Navigating from a dialog thread row must not reopen the old dialog on return.
  useEffect(() => {
    if (!isDirectorThread) {
      setCardId(null);
    }
  }, [isDirectorThread]);
  if (!isDirectorThread) {
    return null;
  }

  const items = inbox.groups.flatMap((group) =>
    pendingActionItems({ cards: group.cards, waitingThreads: group.waitingThreads }).map(
      (item) => ({
        ...item,
        label: group.isDirector ? item.label : `${titleOf(group)} · ${item.label}`,
      }),
    ),
  );
  return {
    banner: pendingActionsBannerItem({
      id: "director-pending-actions",
      items,
      onRevealCard: (id) => {
        if (input.cards.some((card) => card.item.id === id)) {
          input.onRevealCard(id);
        } else {
          setCardId(id);
        }
      },
      onOpenThread: (threadId) => {
        const group = inbox.groups.find((entry) =>
          entry.waitingThreads.some((thread) => thread.threadId === threadId),
        );
        if (group) {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(group.environmentId, threadId)),
          });
        }
      },
    }),
    dialog: <DirectorInboxDialog cardId={cardId} onClose={() => setCardId(null)} />,
  };
}
