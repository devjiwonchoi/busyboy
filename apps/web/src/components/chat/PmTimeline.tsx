import { createContext, type ReactNode } from "react";

import type { MessageId, ProjectManagerPersona } from "@t3tools/contracts";

import { PmAvatar } from "../PmAvatar";

import type { PmSitrepReply } from "./MessagesTimeline.logic";

export interface PmTimelineState {
  /** Shown above each assistant reply; null outside project manager threads. */
  readonly authorHeader: ReactNode;
  readonly authorHeaderMessageIds: ReadonlySet<MessageId>;
  readonly sitrepReplies: ReadonlyMap<MessageId, PmSitrepReply>;
}

/** Null outside project manager threads, so normal threads render unchanged. */
export const PmTimelineCtx = createContext<PmTimelineState | null>(null);

/** Name-only author header; the avatar slots into `[data-pm-author]` later. */
export function PmAuthorHeader({
  persona,
}: {
  readonly persona: Pick<ProjectManagerPersona, "name" | "avatar">;
}) {
  return (
    <div
      className="mb-1 flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground"
      data-pm-author=""
    >
      <PmAvatar persona={persona} status="idle" showStatus={false} size="sm" />
      <span>{persona.name}</span>
    </div>
  );
}

export function PmEventLine({ text }: { readonly text: string }) {
  return (
    <div
      role="note"
      className="mx-auto flex w-full max-w-(--chat-content-max-width) items-center gap-3 py-1 text-2xs text-muted-foreground"
      data-pm-event-line=""
    >
      <span aria-hidden="true" className="h-px flex-1 bg-border/60" />
      <span className="min-w-0 shrink truncate">
        <span className="sr-only">From BusyBoy: </span>
        {text}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-border/60" />
    </div>
  );
}

function formatSitrepSince(since: string | null): string | null {
  if (since === null) return null;
  const date = new Date(since);
  if (Number.isNaN(date.getTime())) return null;
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(undefined, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

export function PmSitrepCard({
  reply,
  children,
}: {
  readonly reply: PmSitrepReply;
  readonly children: ReactNode;
}) {
  const since = formatSitrepSince(reply.since);
  return (
    <section
      aria-label="Sitrep"
      className="relative overflow-hidden rounded-lg border border-border/70 bg-card/40 py-2.5 ps-4 pe-3"
      data-pm-sitrep-card=""
    >
      <span aria-hidden="true" className="absolute inset-y-0 start-0 w-1 bg-info" />
      <p className="mb-1 px-1 text-xs font-medium text-info-foreground">
        {since === null ? "Sitrep" : `Sitrep · since ${since}`}
      </p>
      {children}
    </section>
  );
}
