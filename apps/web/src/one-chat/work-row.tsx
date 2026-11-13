import type { EnvironmentId, GraphNode, ProjectId, ProjectTaskId } from "@t3tools/contracts";
import type { WorkItem } from "@t3tools/shared/one-chat";
import { projectMentionHandle } from "@t3tools/shared/one-chat";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { taskRouteParams } from "~/taskRoutes";
import { NodeEndStateModal } from "./node-end-state-modal";

/** Names and nodes the rows look up by id. */
export interface WorkLookup {
  readonly titleOf: (id: string) => string;
  readonly nodeOf: (nodeId: string) => GraphNode | null;
}

/** Scrolls the feed to a card and highlights it for a moment. */
export function revealCard(cardId: string): boolean {
  const element = document.querySelector<HTMLElement>(
    `[data-one-chat-card="${CSS.escape(cardId)}"]`,
  );
  if (element === null) return false;
  element.scrollIntoView({ block: "center", behavior: "smooth" });
  element.dataset.highlighted = "true";
  window.setTimeout(() => {
    delete element.dataset.highlighted;
  }, 1600);
  return true;
}

/** The work list: one row per item, each expandable in place. */
export function WorkList({
  items,
  environmentId,
  lookup,
  onReveal,
  className,
}: {
  items: ReadonlyArray<WorkItem>;
  environmentId: EnvironmentId | null;
  lookup: WorkLookup;
  /** Called after a waiting row scrolled the feed to its card. */
  onReveal?: () => void;
  className?: string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <ul className={cn("flex flex-col", className)} data-one-chat-work-list>
      {items.map((item) => (
        <WorkRow
          key={item.id}
          item={item}
          open={openId === item.id}
          environmentId={environmentId}
          lookup={lookup}
          onToggle={() => {
            setOpenId(openId === item.id ? null : item.id);
            if (item.state === "waiting_on_me" && item.cardId !== null && revealCard(item.cardId)) {
              onReveal?.();
            }
          }}
        />
      ))}
    </ul>
  );
}

function WorkRow({
  item,
  open,
  environmentId,
  lookup,
  onToggle,
}: {
  item: WorkItem;
  open: boolean;
  environmentId: EnvironmentId | null;
  lookup: WorkLookup;
  onToggle: () => void;
}) {
  const navigate = useNavigate();
  const [endStateOpen, setEndStateOpen] = useState(false);
  const viewEndState = () => {
    if (item.nodeId !== null) {
      setEndStateOpen(true);
      return;
    }
    if (environmentId === null || item.taskId === null) return;
    void navigate(
      taskRouteParams(environmentId, item.projectId as ProjectId, item.taskId as ProjectTaskId),
    );
  };
  return (
    <li data-one-chat-work-row={item.taskId ?? item.nodeId ?? item.id} data-state={item.state}>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-muted/60"
        onClick={onToggle}
      >
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            item.state === "waiting_on_me" ? "bg-info" : "bg-success",
          )}
        />
        <span className="min-w-0 truncate">{item.title}</span>
        <span className="shrink-0 text-muted-foreground text-xs">
          {item.projectName ? `@${projectMentionHandle(item.projectName)}` : null}
        </span>
        <span className="ms-auto shrink-0 text-muted-foreground text-xs">{item.statusLabel}</span>
      </button>
      {open ? (
        <dl
          data-one-chat-work-detail
          className="mb-1 ms-6 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs"
        >
          <dt className="text-muted-foreground">Subtasks</dt>
          <dd>
            {item.childIds.length === 0
              ? "None"
              : `${item.childIds.length}: ${item.childIds.map(lookup.titleOf).join(", ")}`}
          </dd>
          <dt className="text-muted-foreground">Progress</dt>
          <dd>{item.phaseLabel || item.statusLabel}</dd>
          <dt className="text-muted-foreground">Links</dt>
          <dd>{item.waitsOnIds.length === 0 ? "None" : `Waits on ${item.waitsOnIds.length}`}</dd>
          <dd className="col-span-2">
            <button
              type="button"
              className="text-primary underline-offset-2 hover:underline"
              data-one-chat-end-state
              onClick={viewEndState}
            >
              View end state
            </button>
          </dd>
        </dl>
      ) : null}
      {endStateOpen && item.nodeId !== null ? (
        <NodeEndStateModal
          node={lookup.nodeOf(item.nodeId)}
          onOpenChange={(open) => setEndStateOpen(open)}
        />
      ) : null}
    </li>
  );
}
