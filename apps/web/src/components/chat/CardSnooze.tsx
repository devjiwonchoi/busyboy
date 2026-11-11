import { PROJECT_ATTENTION_SNOOZE_REASON_MAX } from "@t3tools/contracts";
import type { EnvironmentId, ProjectDecisionCard } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useState } from "react";

import { useSnoozeDecision, useUnsnoozeDecision } from "~/state/projectTeam";
import { CARD_LABEL } from "~/state/projectTeam.logic";

/**
 * A waiting card with its header row and a quiet "보류" action. Snoozing asks for a
 * reason first; the card then leaves the waiting list for the "보류" section.
 */
export function SnoozableCard(props: {
  card: ProjectDecisionCard;
  environmentId: EnvironmentId;
  /** The header's left side, e.g. the card label or a task link. */
  label: ReactNode;
  /** More header buttons, e.g. "채팅에서 보기". */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="mb-1 flex items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 break-words text-muted-foreground">{props.label}</span>
        <button
          type="button"
          data-snooze-button
          aria-expanded={open}
          className="shrink-0 rounded-md px-2 py-1 text-xs hover:bg-muted"
          onClick={() => setOpen((value) => !value)}
        >
          보류
        </button>
        {props.actions}
      </div>
      {open ? (
        <SnoozeReasonForm
          card={props.card}
          environmentId={props.environmentId}
          onDone={() => setOpen(false)}
        />
      ) : null}
      {props.children}
    </>
  );
}

function SnoozeReasonForm(props: {
  card: ProjectDecisionCard;
  environmentId: EnvironmentId;
  onDone: () => void;
}) {
  const snooze = useSnoozeDecision();
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const trimmed = reason.trim();
  const submit = async () => {
    if (trimmed === "" || sending) return;
    setSending(true);
    setFailed(false);
    const result = await snooze(props.environmentId, {
      projectId: props.card.item.projectId,
      attentionItemId: props.card.item.id,
      reason: trimmed,
    });
    setSending(false);
    if (AsyncResult.isFailure(result)) {
      setFailed(true);
      return;
    }
    props.onDone();
  };
  return (
    <form
      data-snooze-form
      className="mb-2 flex min-w-0 flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <input
          data-snooze-reason-input
          aria-label="보류 이유"
          placeholder="보류 이유"
          autoFocus
          maxLength={PROJECT_ATTENTION_SNOOZE_REASON_MAX}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
        />
        <button
          type="submit"
          data-snooze-submit
          disabled={trimmed === "" || sending}
          className="shrink-0 rounded-md border border-border px-3 py-1 text-sm hover:bg-muted disabled:opacity-50"
        >
          보류
        </button>
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-1 text-sm hover:bg-muted"
          onClick={props.onDone}
        >
          취소
        </button>
      </div>
      {failed ? <p className="text-muted-foreground text-xs">보류하지 못했어요</p> : null}
    </form>
  );
}

/** The collapsed "보류 N" list at the bottom of the waiting window. */
export function SnoozedCards(props: {
  entries: ReadonlyArray<{
    card: ProjectDecisionCard;
    environmentId: EnvironmentId;
    label?: string;
  }>;
}) {
  if (props.entries.length === 0) return null;
  return (
    <details data-snoozed-section className="border-border border-t pt-3 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        보류 {props.entries.length}
      </summary>
      <ul className="mt-2 flex flex-col gap-2">
        {props.entries.map((entry) => (
          <SnoozedRow key={entry.card.item.id} {...entry} />
        ))}
      </ul>
    </details>
  );
}

function SnoozedRow(props: {
  card: ProjectDecisionCard;
  environmentId: EnvironmentId;
  label?: string;
}) {
  const unsnooze = useUnsnoozeDecision();
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const { item } = props.card;
  return (
    <li data-snoozed-card={item.id} className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1">
        <p className="break-words text-foreground text-sm">
          {props.label ?? `${CARD_LABEL[item.kind]}: ${props.card.taskTitle}`}
        </p>
        <p className="break-words text-muted-foreground">이유: {item.snoozeReason ?? ""}</p>
        {failed ? <p className="text-muted-foreground">다시 꺼내지 못했어요</p> : null}
      </div>
      <button
        type="button"
        data-unsnooze-button
        disabled={sending}
        className="shrink-0 rounded-md px-2 py-1 hover:bg-muted disabled:opacity-50"
        onClick={async () => {
          setSending(true);
          setFailed(false);
          const result = await unsnooze(props.environmentId, {
            projectId: item.projectId,
            attentionItemId: item.id,
          });
          setSending(false);
          if (AsyncResult.isFailure(result)) setFailed(true);
        }}
      >
        다시 꺼내기
      </button>
    </li>
  );
}
