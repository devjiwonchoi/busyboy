"use client";

import { Check } from "lucide-react";
import { useState } from "react";

import { readTaskPlanAction } from "@/app/(main)/director-actions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cardGroupLabel, type DoneCard } from "@/server/cards/model";

import { Markdown } from "../../markdown";
import { PhaseMark } from "../../phase-mark";
import { useCardActions } from "../card-actions";
import { CardShell, CardShellHeader } from "../card-shell";
import type { CardViewProps } from "../card-view-props";

function pendingChecks(count: number) {
  return ` · ${count} ${count === 1 ? "check" : "checks"} pending`;
}

export function DoneCardView({ card }: CardViewProps<DoneCard>) {
  const { replying } = useCardActions();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<{ title: string; plan: string; verify: string | null } | null>(
    null,
  );
  const [missing, setMissing] = useState(false);
  const share = card.achievement;

  async function viewPlan() {
    setOpen(true);
    setMissing(false);
    try {
      const result = await readTaskPlanAction(card.taskId);
      if (!result) setMissing(true);
      else setPlan(result);
    } catch {
      setMissing(true);
    }
  }

  return (
    <CardShell label={cardGroupLabel(card)} replying={replying} variant="line">
      <CardShellHeader
        title={
          <span className="inline-flex items-center gap-2 whitespace-nowrap">
            <span
              className="bg-success flex size-3.5 shrink-0 items-center justify-center rounded-full text-white"
              aria-hidden
            >
              <Check className="size-2.5" strokeWidth={3} />
            </span>
            <span className="font-semibold">{card.taskTitle}</span>
            <span className="text-muted-foreground inline-flex items-center gap-1.5 font-normal">
              {card.phase === "pr" ? (
                <>
                  <span aria-hidden>·</span>
                  <PhaseMark phase="pr" />
                  {card.pendingChecks > 0 && <span>{pendingChecks(card.pendingChecks)}</span>}
                </>
              ) : (
                " · Done"
              )}
              {share ? ` · ${share.met}/${share.agreed} end state` : ""}
            </span>
          </span>
        }
        meta={
          <button
            type="button"
            className="text-muted-foreground cursor-pointer border-0 bg-transparent p-0 text-xs font-normal underline underline-offset-2"
            onClick={() => void viewPlan()}
          >
            View plan
          </button>
        }
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg" className="overflow-hidden">
          <DialogHeader>
            <DialogTitle>{plan?.title ?? card.taskTitle}</DialogTitle>
            <DialogDescription>{card.project}</DialogDescription>
          </DialogHeader>
          {/* The title stays put while the note scrolls, the same pane View details uses for a plan. */}
          {plan ? (
            <div className="min-h-0 overflow-y-auto">
              <Markdown text={plan.plan} />
              {plan.verify ? <Markdown text={plan.verify} /> : null}
            </div>
          ) : missing ? (
            <p>The plan could not be read.</p>
          ) : null}
        </DialogContent>
      </Dialog>
    </CardShell>
  );
}
