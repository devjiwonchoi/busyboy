import { useWaitingPulse } from "../WaitingAlerts";
import type { LegendListRef } from "@legendapp/list/react";
import type {
  EnvironmentId,
  ProjectDecisionCard,
  ProjectWaitingThread,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { BellDotIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useDirectorInbox } from "~/state/director";
import { isSnoozedDecisionCard, pendingActionItems } from "~/state/projectTeam.logic";
import { DirectorInbox } from "../director/DirectorInbox";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogPopup, DialogTitle } from "../ui/dialog";
import { SnoozableCard, SnoozedCards } from "./CardSnooze";
import { DecisionCard } from "./DecisionCard";

const HIGHLIGHT_MS = 1800;
const REVEAL_ATTEMPTS = 30;

function cardElement(scrollNode: Element, cardId: string): HTMLElement | null {
  return scrollNode.querySelector<HTMLElement>(`[data-decision-card="${CSS.escape(cardId)}"]`);
}

/** True when part of the element shows inside the scroll viewport. */
function isInView(scrollNode: Element, element: HTMLElement): boolean {
  const viewport = scrollNode.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return rect.bottom > viewport.top && rect.top < viewport.bottom;
}

function flash(element: HTMLElement) {
  element.dataset.decisionCardHighlighted = "true";
  window.setTimeout(() => {
    delete element.dataset.decisionCardHighlighted;
  }, HIGHLIGHT_MS);
}

/** Scrolls the timeline to a question card and flashes it; the row may mount only on arrival. */
export function revealDecisionCard(list: LegendListRef | null, cardId: string): void {
  if (!list) return;
  const index = list.getState().indexByKey(`decision-card:${cardId}`);
  if (index !== undefined) {
    void list.scrollToIndex({ index, animated: true, viewPosition: 0, viewOffset: 24 });
  }
  let attempts = 0;
  const tryFlash = () => {
    const scrollNode = list.getScrollableNode();
    const element = scrollNode ? cardElement(scrollNode, cardId) : null;
    if (element && (index === undefined || isInView(scrollNode!, element))) {
      if (index === undefined) element.scrollIntoView({ block: "start", behavior: "smooth" });
      flash(element);
      return;
    }
    attempts += 1;
    if (attempts < REVEAL_ATTEMPTS) window.setTimeout(tryFlash, 50);
  };
  tryFlash();
}

/** A pill beside "Scroll to end" that opens every waiting item in a dialog. */
export function PendingActionsPill(props: {
  count: number;
  /** Cards the user snoozed; with nothing else waiting the pill offers only "보류 N". */
  snoozedCount?: number;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pulse = useWaitingPulse(props.count);
  const snoozed = props.snoozedCount ?? 0;
  if (props.count === 0 && snoozed === 0) {
    // The last item was answered: close, so the next item doesn't reopen the dialog.
    if (open) setOpen(false);
    return null;
  }
  const close = () => setOpen(false);
  const waiting = props.count > 0;
  return (
    <>
      <Button
        aria-label={waiting ? `기다리는 일 ${props.count}개 보기` : `보류 ${snoozed}개 보기`}
        data-pending-actions-button={props.count}
        data-waiting-pulse={pulse}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => setOpen(true)}
        className={
          waiting
            ? "pointer-events-auto border-warning/40 bg-warning/15 text-warning-foreground"
            : "pointer-events-auto text-muted-foreground"
        }
        size="xs"
        variant="glass"
      >
        {waiting ? (
          <>
            <BellDotIcon className="size-3.5 text-warning-foreground" />
            기다리는 일 {props.count}개
          </>
        ) : (
          <>보류 {snoozed}</>
        )}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup
          showCloseButton={false}
          data-pending-actions-dialog
          className="flex max-h-[85dvh] w-full min-w-0 flex-col overflow-y-auto p-4 sm:max-w-3xl"
        >
          <div className="mb-4 flex items-center gap-2">
            <DialogTitle className="flex-1">나를 기다리는 일 {props.count}</DialogTitle>
            <DialogClose className="rounded-md px-3 py-2 text-sm hover:bg-muted">닫기</DialogClose>
          </div>
          {props.children(close)}
        </DialogPopup>
      </Dialog>
    </>
  );
}

/** A PM or lead chat: its own open cards and the threads waiting on the user. */
export function ThreadPendingActions(props: {
  cards: ReadonlyArray<ProjectDecisionCard>;
  waitingThreads: ReadonlyArray<ProjectWaitingThread>;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  cwd: string | undefined;
  onRevealCard: (cardId: string) => void;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const items = pendingActionItems({ cards: props.cards, waitingThreads: props.waitingThreads });
  const cardsById = new Map(props.cards.map((card) => [card.item.id as string, card]));
  const snoozed = props.cards.filter(isSnoozedDecisionCard);
  return (
    <PendingActionsPill count={items.length} snoozedCount={snoozed.length}>
      {(close) => (
        <div className="flex min-w-0 flex-col gap-4">
          {items.map((item) => {
            if (item.kind === "card") {
              const card = cardsById.get(item.id);
              return card === undefined ? null : (
                <div key={item.id} data-pending-actions-card={item.id} className="min-w-0">
                  <SnoozableCard
                    card={card}
                    environmentId={props.environmentId}
                    label={item.label}
                    actions={
                      <RevealInChatButton
                        onClick={() => {
                          close();
                          props.onRevealCard(item.id);
                        }}
                      />
                    }
                  >
                    <DecisionCard
                      card={card}
                      environmentId={props.environmentId}
                      threadRef={props.threadRef}
                      cwd={props.cwd}
                    />
                  </SnoozableCard>
                </div>
              );
            }
            return (
              <div
                key={item.threadId}
                data-pending-actions-thread={item.threadId}
                className="flex min-w-0 items-center gap-2 rounded-lg border border-dashed border-border p-3 text-sm"
              >
                <span className="min-w-0 flex-1 break-words">{item.label}</span>
                <button
                  type="button"
                  className="shrink-0 rounded-md px-3 py-2 hover:bg-muted"
                  onClick={() => {
                    close();
                    props.onOpenThread(item.threadId);
                  }}
                >
                  열기
                </button>
              </div>
            );
          })}
          <SnoozedCards
            entries={snoozed.map((card) => ({ card, environmentId: props.environmentId }))}
          />
        </div>
      )}
    </PendingActionsPill>
  );
}

/** Closes the dialog and scrolls the timeline to the card. */
function RevealInChatButton(props: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="shrink-0 rounded-md px-2 py-1 text-xs hover:bg-muted"
      onClick={props.onClick}
    >
      채팅에서 보기
    </button>
  );
}

/** The Director chat: everything waiting across every project. */
export function DirectorPendingActions(props: { onRevealCard: (cardId: string) => void }) {
  const { total, snoozedTotal } = useDirectorInbox();
  return (
    <PendingActionsPill count={total} snoozedCount={snoozedTotal}>
      {(close) => (
        <DirectorInbox
          highlightCardId={null}
          showEmpty={false}
          showHeading={false}
          onNavigate={close}
          onRevealDirectorCard={(cardId) => {
            close();
            props.onRevealCard(cardId);
          }}
        />
      )}
    </PendingActionsPill>
  );
}
