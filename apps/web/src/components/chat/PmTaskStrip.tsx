import type {
  EnvironmentId,
  ProjectId,
  ProjectTaskCard,
  ProjectTaskCardLine,
  ProjectTaskStage,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { ListTodoIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";
import { useMessageTask } from "../../state/projectTeam";
import { Input } from "../ui/input";
import { ComposerBanner } from "./ComposerBanner";

export const PM_TASK_STRIP_COLLAPSED_STORAGE_KEY = "t3code:pm-task-strip-collapsed";

const STAGE_LABEL: Partial<Record<ProjectTaskStage, string>> = {
  planning: "planning",
  running: "running",
  in_review: "in review",
  blocked: "blocked",
};

const STAGE_CLASS: Partial<Record<ProjectTaskStage, string>> = {
  running: "border-info/30 text-info",
  in_review: "border-success/30 text-success",
  blocked: "border-warning/30 text-warning",
};

function RelativeTime({ at }: { at: string }) {
  const state = useRelativeTimeState(at);
  if (state.status !== "relative") return null;
  return (
    <time dateTime={at} className="flex-none tabular-nums">
      {state.suffix ? `${state.value} ${state.suffix}` : state.value}
    </time>
  );
}

/**
 * The PM thread's active tasks, pinned above the composer. Each card shows where the task is
 * and takes a one-line message that goes straight to the task's lead, so the user never has to
 * wait for the PM's turn to reach a task.
 */
export function PmTaskStrip({
  environmentId,
  projectId,
  taskCards,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  taskCards: ReadonlyArray<ProjectTaskCard>;
}) {
  const [collapsed, setCollapsed] = useLocalStorage(
    PM_TASK_STRIP_COLLAPSED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  if (taskCards.length === 0) return null;
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root data-pm-task-strip="true">
        <ComposerBanner.Row
          render={<button type="button" />}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          <ComposerBanner.Icon>
            <ListTodoIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="font-medium text-muted-foreground">
            Tasks · {taskCards.length}
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerBanner.ToggleIcon expanded={!collapsed} />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        {collapsed ? null : (
          <ComposerBanner.Scroll className="max-h-[min(16rem,30dvh)]">
            <ul className="grid gap-1 px-1 pt-1 pb-1">
              {taskCards.map((card) => (
                <TaskCard
                  key={card.id}
                  card={card}
                  environmentId={environmentId}
                  projectId={projectId}
                />
              ))}
            </ul>
          </ComposerBanner.Scroll>
        )}
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

/** The newer of the server's last message and the one just sent from this card. */
export function shownDirectMessage(
  fromServer: ProjectTaskCardLine | null,
  justSent: ProjectTaskCardLine | null,
): ProjectTaskCardLine | null {
  if (justSent === null) return fromServer;
  if (fromServer === null) return justSent;
  return Date.parse(fromServer.at) >= Date.parse(justSent.at) ? fromServer : justSent;
}

function TaskCard({
  card,
  environmentId,
  projectId,
}: {
  card: ProjectTaskCard;
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const messageTask = useMessageTask();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [justSent, setJustSent] = useState<ProjectTaskCardLine | null>(null);
  const lastMessage = shownDirectMessage(card.lastDirectMessage, justSent);

  const send = () => {
    const text = draft.trim();
    if (text.length === 0 || sending) return;
    setSending(true);
    void messageTask(environmentId, { projectId, taskId: card.id, text }).then((result) => {
      setSending(false);
      // On failure the text stays so the user can send it again.
      if (!AsyncResult.isSuccess(result)) return;
      setDraft("");
      setJustSent({ text, at: new Date().toISOString() });
    });
  };

  return (
    <li
      data-task-card={card.id}
      data-task-stage={card.stage}
      className="grid gap-1 rounded-lg border border-border/70 bg-card/60 px-2 py-1.5 text-xs"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate font-medium text-foreground">{card.title}</span>
        <span
          data-task-stage-chip=""
          className={cn(
            "flex-none rounded-full border border-border/70 px-1.5 text-[10px]/4 text-muted-foreground",
            STAGE_CLASS[card.stage],
          )}
        >
          {STAGE_LABEL[card.stage] ?? card.stage}
        </span>
      </div>
      {card.latestUpdate ? (
        <div className="flex min-w-0 items-baseline gap-1.5 text-muted-foreground">
          <span data-task-latest-update="" className="min-w-0 truncate">
            {card.latestUpdate.text}
          </span>
          <RelativeTime at={card.latestUpdate.at} />
        </div>
      ) : null}
      <Input
        size="compact"
        nativeInput
        value={draft}
        disabled={sending}
        placeholder="Message the lead…"
        aria-label={`Message the lead of ${card.title}`}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.stopPropagation();
          send();
        }}
      />
      {lastMessage ? (
        <div
          data-task-last-message=""
          className="flex min-w-0 items-baseline gap-1 text-muted-foreground"
        >
          <span className="flex-none">
            You · <RelativeTime at={lastMessage.at} />:
          </span>
          <span className="min-w-0 truncate text-foreground/80">{lastMessage.text}</span>
        </div>
      ) : null}
    </li>
  );
}
