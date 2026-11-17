"use client";

import { mergePullRequestsAction } from "@/app/(main)/director-actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { cardGroupLabel, type PrCard, type PullRequestCheck } from "@/server/cards/model";

import { CardActionError, useCardActions } from "../card-actions";
import { CardShell, CardShellActions, CardShellBody, CardShellHeader } from "../card-shell";
import type { CardViewProps } from "../card-view-props";

const CHECK_DOT: Record<Exclude<PullRequestCheck, "none">, string> = {
  passing: "bg-success",
  failing: "bg-destructive",
  pending: "bg-warning",
};

const CHECK_LABEL: Record<Exclude<PullRequestCheck, "none">, string> = {
  passing: "Checks passing",
  failing: "Checks failing",
  pending: "Checks pending",
};

/** One row per pull request, in stack order. Open and Merge in order are the only actions. */
export function PrCardView({ card }: CardViewProps<PrCard>) {
  const { pending, replying, run } = useCardActions();
  const first = card.pulls[0];
  return (
    <CardShell label={cardGroupLabel(card)} replying={replying}>
      <CardShellHeader
        title={<span className="font-semibold">{card.title}</span>}
        meta={<span className="text-muted-foreground text-xs font-normal">{card.project}</span>}
      />
      <CardShellBody>
        <ul className="space-y-2">
          {card.pulls.map((pull) => (
            <li key={pull.number} className="flex items-center gap-2">
              {pull.check !== "none" ? (
                <span
                  data-check={pull.check}
                  className={cn("size-1.5 shrink-0 rounded-full", CHECK_DOT[pull.check])}
                  aria-hidden
                />
              ) : (
                <span className="size-1.5 shrink-0" aria-hidden />
              )}
              <a
                href={pull.url}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 truncate text-inherit no-underline"
              >
                #{pull.number} {pull.title}
              </a>
              {pull.check !== "none" && (
                <span className="text-muted-foreground ml-auto shrink-0">
                  {CHECK_LABEL[pull.check]}
                </span>
              )}
              {pull.check === "none" && pull.review && (
                <span className="text-muted-foreground ml-auto shrink-0">{pull.review}</span>
              )}
            </li>
          ))}
        </ul>
        {card.note && <p className="text-muted-foreground">{card.note}</p>}
        <CardActionError />
      </CardShellBody>
      <CardShellActions>
        {first && (
          <a
            href={first.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground text-xs font-normal"
          >
            Open
          </a>
        )}
        <Button
          type="button"
          size="sm"
          disabled={pending || card.pulls.length === 0}
          onClick={() =>
            run(
              () => mergePullRequestsAction(card.id),
              "The pull requests could not be merged. Try again.",
            )
          }
        >
          Merge in order
        </Button>
      </CardShellActions>
    </CardShell>
  );
}
