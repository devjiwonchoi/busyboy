import type { EnvironmentId } from "@t3tools/contracts";
import { isToastVisible, type WorkCounts, type WorkItem } from "@t3tools/shared/one-chat";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { WorkModal } from "./work-modal";
import { type WorkLookup, WorkList } from "./work-row";

export function workSummary(counts: WorkCounts): string {
  return `Waiting on you ${counts.waitingOnMe} · Running ${counts.running}`;
}

/** The work toast above the composer: one line collapsed, a short list expanded. */
export function WorkToast({
  items,
  counts,
  environmentId,
  lookup,
}: {
  items: ReadonlyArray<WorkItem>;
  counts: WorkCounts;
  environmentId: EnvironmentId | null;
  lookup: WorkLookup;
}) {
  const [expanded, setExpanded] = useState(false);
  const [large, setLarge] = useState(false);
  if (!isToastVisible(counts)) return null;
  return (
    <section
      data-one-chat-toast={expanded ? "expanded" : "collapsed"}
      aria-label="Work"
      className="mx-auto w-full max-w-3xl rounded-xl border bg-card/80 px-2 py-1.5 shadow-xs"
    >
      {expanded ? (
        <WorkList
          items={items}
          environmentId={environmentId}
          lookup={lookup}
          className="max-h-[180px] overflow-y-auto"
        />
      ) : null}
      {/* On a narrow screen the buttons wrap below rather than cutting the counts off. */}
      <div className="flex flex-wrap items-center gap-1 px-1 text-sm">
        <span data-one-chat-toast-summary className="whitespace-nowrap text-muted-foreground">
          {workSummary(counts)}
        </span>
        <div className="ms-auto flex gap-1">
          <Button size="xs" variant="ghost" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Collapse" : "Expand"}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setLarge(true)}>
            Open large
          </Button>
        </div>
      </div>
      <WorkModal
        open={large}
        onOpenChange={setLarge}
        title={workSummary(counts)}
        items={items}
        environmentId={environmentId}
        lookup={lookup}
      />
    </section>
  );
}
