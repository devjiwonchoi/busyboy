import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  type ProjectDecisionCard,
  type ProjectWaitingThread,
  ThreadId,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { act } from "react";
import { userEvent } from "vite-plus/test/browser";

import { revealDecisionCard, ThreadPendingActions } from "./PendingActionsButton";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");

/** The pill as ChatView floats it beside "Scroll to end", above the composer. */
export function PendingActions(props: {
  cards: ReadonlyArray<ProjectDecisionCard>;
  waitingThreads?: ReadonlyArray<ProjectWaitingThread>;
  listRef: React.RefObject<LegendListRef | null>;
  threadId?: ThreadId;
  onOpenThread?: (threadId: ThreadId) => void;
}) {
  return (
    <div
      data-testid="pending-actions-lane"
      style={{ display: "flex", justifyContent: "center", gap: 8, padding: "6px 0" }}
    >
      <ThreadPendingActions
        cards={props.cards}
        waitingThreads={props.waitingThreads ?? []}
        environmentId={ENVIRONMENT_ID}
        threadRef={scopeThreadRef(ENVIRONMENT_ID, props.threadId ?? ThreadId.make("pm-thread"))}
        cwd={undefined}
        onRevealCard={(cardId) => revealDecisionCard(props.listRef.current, cardId)}
        onOpenThread={props.onOpenThread ?? (() => {})}
      />
    </div>
  );
}

/** The pill; it carries the count and is null while nothing waits. */
export const pendingButton = () =>
  document.querySelector<HTMLElement>("[data-pending-actions-button]");

/** The open dialog listing every waiting item, or null. */
export const pendingDialog = () =>
  document.querySelector<HTMLElement>("[data-pending-actions-dialog]");

export async function openPendingActions(): Promise<HTMLElement> {
  const button = pendingButton();
  if (!button) {
    throw new Error("Missing pending actions button");
  }
  await act(async () => userEvent.click(button));
  const dialog = pendingDialog();
  if (!dialog) {
    throw new Error("Pending actions dialog did not open");
  }
  return dialog;
}

/** Open the dialog and jump to one card in the chat. */
export async function revealPendingCard(cardId: string) {
  const dialog = await openPendingActions();
  const row = dialog.querySelector<HTMLElement>(
    `[data-pending-actions-card="${CSS.escape(cardId)}"]`,
  );
  const button = [...(row?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent === "채팅에서 보기",
  );
  if (!button) {
    throw new Error(`Missing pending card ${cardId}`);
  }
  await act(async () => userEvent.click(button));
}
