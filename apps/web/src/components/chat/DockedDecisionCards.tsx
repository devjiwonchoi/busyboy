import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import type { DockedDecisionCard } from "../../state/projectTeam.logic";
import { ComposerBanner } from "./ComposerBanner";
import { OpenDecisionCard, decisionCardQuestion } from "./DecisionCard";

/**
 * Open decision cards docked above the composer, one at a time with a 1/N pager, so they
 * stay in view while the conversation scrolls. A card leaves once answered or replaced.
 */
export function DockedDecisionCards({
  cards,
  environmentId,
  threadRef,
  cwd,
}: {
  cards: ReadonlyArray<DockedDecisionCard>;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  cwd: string | undefined;
}) {
  const [index, setIndex] = useState(0);
  if (cards.length === 0) return null;
  // When the shown card leaves, the next one slides into its place.
  const shownIndex = Math.min(index, cards.length - 1);
  const shown = cards[shownIndex]!;

  return (
    <ComposerBanner.Attachment data-docked-decision-cards={cards.length}>
      <ComposerBanner.Root variant="info">
        {cards.length > 1 ? (
          <ComposerBanner.Row data-docked-decision-pager>
            <ComposerBanner.Content>
              <span className="font-medium text-muted-foreground">Waiting on you</span>
            </ComposerBanner.Content>
            <ComposerBanner.Actions>
              <ComposerBanner.Dismiss
                aria-label="Previous card"
                title="Previous card"
                disabled={shownIndex === 0}
                onClick={() => setIndex(shownIndex - 1)}
              >
                <ChevronLeftIcon className="size-3.5" />
              </ComposerBanner.Dismiss>
              <span
                className="text-3xs font-medium text-muted-foreground tabular-nums"
                data-docked-decision-position
              >
                {shownIndex + 1}/{cards.length}
              </span>
              <ComposerBanner.Dismiss
                aria-label="Next card"
                title="Next card"
                disabled={shownIndex === cards.length - 1}
                onClick={() => setIndex(shownIndex + 1)}
              >
                <ChevronRightIcon className="size-3.5" />
              </ComposerBanner.Dismiss>
            </ComposerBanner.Actions>
          </ComposerBanner.Row>
        ) : null}
        <OpenDecisionCard
          key={shown.card.item.id}
          card={shown.card}
          question={decisionCardQuestion(shown.card, shown.taskKey)}
          environmentId={environmentId}
          threadRef={threadRef}
          cwd={cwd}
          docked
        />
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
