import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { ArrowUpIcon } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useId, useState } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { cn, newMessageId } from "~/lib/utils";
import type { ProjectManagerEntry } from "~/state/projectTeam";
import { formatProjectManagerPresence } from "~/state/projectTeam.logic";
import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { PmAvatar } from "../PmAvatar";
import { projectManagerPreview } from "../SidebarProjectManager";
import { toastManager } from "../ui/toast";
import type { DirectorChat } from "./useDirectorChat";

/** Workspace totals for the card's stats line. */
export function workspaceDigestStats(projects: ReadonlyArray<ProjectManagerEntry>): string {
  let running = 0;
  let review = 0;
  let waiting = 0;
  for (const { summary } of projects) {
    waiting += summary.openCount;
    for (const task of summary.tasks) {
      if (task.stage === "running") running += 1;
      else if (task.stage === "in_review") review += 1;
    }
  }
  return [
    `${projects.length} ${projects.length === 1 ? "project" : "projects"}`,
    `${running} in progress`,
    review > 0 ? `${review} in review` : null,
    waiting > 0 ? `${waiting} waiting on you` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/**
 * The top of All projects: the Director's latest word on the workspace, what
 * it waits on, and a box to message it. Sending goes straight to the
 * Director's chat and opens it.
 */
export function DirectorCard(props: {
  director: DirectorChat;
  projects: ReadonlyArray<ProjectManagerEntry>;
}) {
  const { director } = props;
  const { summary } = director.entry;
  const nowMinute = useNowMinute();
  const presence = formatProjectManagerPresence(summary, Date.parse(`${nowMinute}:00.000Z`));
  const canOperate = useEnvironmentScope(
    director.threadRef.environmentId,
    AuthOrchestrationOperateScope,
  );
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const inputId = useId();
  const thread = director.thread;
  const canSend = canOperate && thread !== null && !sending && text.trim().length > 0;

  const send = async () => {
    if (!canSend || thread === null) return;
    setSending(true);
    const result = await startTurn({
      environmentId: director.threadRef.environmentId,
      input: {
        threadId: director.threadRef.threadId,
        message: { messageId: newMessageId(), role: "user", text: text.trim(), attachments: [] },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        dispatchMode: "auto",
      },
    });
    setSending(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not message the Director",
        description: error instanceof Error ? error.message : "Try again.",
      });
      return;
    }
    setText("");
    void director.open();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void send();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  const preview = director.working ? "Working…" : projectManagerPreview(summary);

  return (
    <section
      aria-label={summary.persona.name}
      data-director-card
      className="rounded-xl border border-border bg-card p-3 sm:p-4"
    >
      <header className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void director.open()}
          aria-label={`Open ${summary.persona.name}'s chat`}
          className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PmAvatar persona={summary.persona} status={director.status} size="lg" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h2 className="truncate font-medium text-sm">{summary.persona.name}</h2>
            {summary.persona.name === "Director" ? null : (
              <span className="shrink-0 text-muted-foreground text-xs">Director</span>
            )}
          </div>
          <p className="truncate text-muted-foreground text-xs">{presence}</p>
        </div>
        {summary.openCount > 0 ? (
          <button
            type="button"
            data-director-waiting
            onClick={() => void director.open()}
            className="shrink-0 rounded-full bg-warning/16 px-2.5 py-1 font-medium text-warning text-xs outline-none hover:bg-warning/24 focus-visible:ring-2 focus-visible:ring-ring"
          >
            {summary.openCount} {summary.openCount === 1 ? "action" : "actions"} waiting
          </button>
        ) : null}
      </header>
      <p
        data-director-digest
        className={cn(
          "mt-3 line-clamp-4 whitespace-pre-line text-sm",
          summary.lastMessage === null && !director.working && "text-muted-foreground",
        )}
      >
        {summary.lastMessage === null && !director.working
          ? "Ask the Director about anything across your projects. It routes the work to each project's PM."
          : preview}
      </p>
      <p className="mt-2 text-muted-foreground text-xs">{workspaceDigestStats(props.projects)}</p>
      <form onSubmit={onSubmit} className="mt-3 flex items-end gap-2">
        <label htmlFor={inputId} className="sr-only">
          Message {summary.persona.name}
        </label>
        <textarea
          id={inputId}
          rows={1}
          value={text}
          disabled={!canOperate}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Message ${summary.persona.name}…`}
          className="field-sizing-content max-h-40 min-h-9 min-w-0 flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 disabled:opacity-64 sm:text-sm"
        />
        <button
          type="submit"
          aria-label="Send to Director"
          disabled={!canSend}
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          <ArrowUpIcon aria-hidden className="size-4" />
        </button>
      </form>
    </section>
  );
}
