"use client";

import { useId, useState } from "react";

import { approveCardAction } from "@/app/(main)/director-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cardGroupLabel, type PlanCard } from "@/server/cards/model";

import { Markdown } from "../../markdown";
import { PhaseMark } from "../../phase-mark";
import { CardActionError, useCardActions } from "../card-actions";
import { CardShell, CardShellActions, CardShellBody, CardShellHeader } from "../card-shell";
import type { CardViewProps } from "../card-view-props";

export function PlanCardView({ card }: CardViewProps<PlanCard>) {
  const { pending, replying, onReplyChange, run } = useCardActions();
  const [details, setDetails] = useState(false);
  const endStateId = useId();

  function approve() {
    setDetails(false);
    void run(() => approveCardAction(card.id), "The plan could not be approved. Try again.");
  }

  function requestChanges() {
    setDetails(false);
    onReplyChange(true);
  }

  return (
    <CardShell label={cardGroupLabel(card)} replying={replying}>
      <CardShellHeader
        title={<span className="font-bold">{card.title}</span>}
        meta={
          <span className="text-muted-foreground inline-flex items-center gap-2 text-[0.6875rem] font-normal">
            <span>{card.project}</span>
            <PhaseMark phase="aligning" />
          </span>
        }
      />
      <CardShellBody>
        {/* why: The shell's section gap is wider than the title-to-summary gap in the mock. */}
        <p className="-mt-2 truncate">{card.summary}</p>
        {card.criteria.length > 0 && (
          <div className="space-y-4 pt-4">
            <p id={endStateId} className="text-muted-foreground text-[0.6875rem]">
              End state
            </p>
            <ol aria-labelledby={endStateId} className="list-decimal space-y-1 pl-5">
              {card.criteria.map((item, index) => (
                <li key={`${index}-${item}`}>{item}</li>
              ))}
            </ol>
          </div>
        )}
        <CardActionError />
      </CardShellBody>
      <CardShellActions>
        <Button
          type="button"
          variant="ghost"
          className="text-muted-foreground px-2 font-normal"
          onClick={() => setDetails(true)}
        >
          View details
        </Button>
        <Button type="button" disabled={pending} onClick={approve}>
          Approve
        </Button>
      </CardShellActions>
      <Dialog open={details} onOpenChange={setDetails}>
        <DialogContent size="lg" className="overflow-hidden">
          <DialogHeader className="pr-8">
            <div className="flex flex-wrap items-center gap-2">
              <DialogDescription className="inline">
                {card.project} · {card.taskTitle}
              </DialogDescription>
              {/* why: Warning tint: this plan is still a draft waiting on the user. */}
              <Badge
                variant="outline"
                className="border-warning/40 bg-warning/10 text-warning-foreground"
              >
                Waiting for approval
              </Badge>
            </div>
            <DialogTitle>{card.title}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto">
            <Markdown text={card.plan} />
          </div>
          <DialogFooter className="border-t pt-4">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={requestChanges}
            >
              Request changes
            </Button>
            <Button type="button" size="sm" disabled={pending} onClick={approve}>
              Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CardShell>
  );
}
