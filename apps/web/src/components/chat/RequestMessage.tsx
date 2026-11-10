import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ProjectApprovalPlanTodo,
  ProjectDecisionCard,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  approveAnswerFor,
  defaultRequestOption,
  formatRequestAnswer,
  formatRequestLink,
  parseRequestMessage,
  REQUEST_APPROVE_LABEL,
  REQUEST_BLOCKER_DONE,
  REQUEST_DETAILS_LABEL,
} from "@t3tools/shared/requestMessage";
import { AsyncResult } from "effect/reactivity";
import { CopyIcon, ReplyIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useComposerHandleContext } from "~/composerHandleContext";
import { useComposerDraftStore } from "~/composerDraftStore";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useAnswerDecision, useProjectManagerEntries, useTaskDetail } from "~/state/projectTeam";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { showAnchoredCopyErrorToast, showAnchoredCopySuccessToast } from "../ui/anchoredCopyToast";
import { useAttentionTask, useRequestSender } from "./AttentionContext";
import { CardSideChat } from "./CardSideChat";
import { parseDecisionOption } from "./DecisionCard.logic";
import { PlanApprovalModal } from "./PlanApprovalModal";

type RequestProps = {
  card: ProjectDecisionCard;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | undefined;
};

/** Open approvals list the plan version being approved, with live done marks. */
export function RequestMessage(props: RequestProps) {
  if (props.card.item.kind === "approval" && props.card.item.taskId !== null) {
    return <PlanRequestMessage {...props} taskId={props.card.item.taskId} />;
  }
  return <MessageBody {...props} todos={[]} nonGoals="" />;
}

function PlanRequestMessage(
  props: RequestProps & { taskId: NonNullable<ProjectDecisionCard["item"]["taskId"]> },
) {
  const query = useTaskDetail(props.environmentId, {
    projectId: props.card.item.projectId,
    taskId: props.taskId,
  });
  const versions = query.data?.versions ?? [];
  const asked = versions.find((entry) => entry.version === props.card.item.specVersion)?.spec;
  const live = versions.at(-1)?.spec;
  const todos = (props.card.plan?.todos ?? asked?.todos ?? []).map((todo) => ({
    ...todo,
    done: live?.todos.find((entry) => entry.id === todo.id)?.done ?? todo.done,
  }));
  return <MessageBody {...props} todos={todos} nonGoals={asked?.nonGoals ?? ""} />;
}

/** A request stays one message; alternative answers and supporting facts are folded inside it. */
function MessageBody({
  card,
  environmentId,
  threadRef,
  todos,
  nonGoals,
}: RequestProps & {
  todos: ReadonlyArray<ProjectApprovalPlanTodo>;
  nonGoals: string;
}) {
  const sender = useRequestSender(card, environmentId);
  const { related } = useAttentionTask({ card, environmentId });
  const entries = useProjectManagerEntries([environmentId]);
  const manager = entries.find((entry) => entry.summary.projectId === card.item.projectId)?.summary;
  // Only the project PM's chat ties a reply to its request, so replies always go there.
  const composerRef = manager
    ? scopeThreadRef(environmentId, manager.pmThreadId)
    : (threadRef ?? null);
  const replyElsewhere = composerRef !== null && composerRef.threadId !== threadRef?.threadId;
  const composerHandle = useComposerHandleContext();
  const answerDecision = useAnswerDecision();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(() =>
    defaultRequestOption(card.item.options),
  );
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const copyRef = useRef<HTMLButtonElement>(null);
  const { copyToClipboard } = useCopyToClipboard<void>({
    onCopy: () => showAnchoredCopySuccessToast(copyRef),
    onError: (error: Error) => showAnchoredCopyErrorToast(copyRef, error),
  });
  const message = parseRequestMessage(card.item.question);
  const planApproval = card.item.kind === "approval";
  const paragraphs =
    message.paragraphs.length === 0 && planApproval && card.item.details == null
      ? [card.plan?.summary ?? card.item.summary ?? ""].filter(Boolean)
      : message.paragraphs;
  const link = formatRequestLink(card.item.id, message.headline);
  const chatThreadId = card.item.askerThreadId ?? manager?.pmThreadId ?? null;
  const lead =
    card.item.senderRole === "lead" ||
    (card.item.senderRole == null && Boolean(related?.task.leadThreadId));

  // Failed answers retain the selected option and note, with an explicit retry message.
  const submit = (answer: string) => {
    if (sending) {
      return;
    }
    setSending(true);
    setFailed(false);
    void answerDecision(environmentId, {
      projectId: card.item.projectId,
      attentionItemId: card.item.id,
      answer,
    }).then((result) => {
      if (!AsyncResult.isSuccess(result)) {
        setSending(false);
        setFailed(true);
      }
    });
  };

  return (
    <div
      data-decision-card={card.item.id}
      data-decision-card-state="open"
      className="group flex min-w-0 flex-col items-start gap-1.5"
    >
      <p data-decision-card-meta className="text-xs text-muted-foreground">
        {sender}
      </p>
      <div
        data-request-bubble
        className="w-full min-w-0 space-y-3 rounded-2xl bg-muted px-4 py-3 text-sm"
      >
        <h3 data-decision-card-headline className="wrap-break-word font-semibold">
          {message.headline}
        </h3>
        {paragraphs.map((paragraph, index) => (
          <p key={index} className="whitespace-pre-wrap wrap-break-word">
            {paragraph}
          </p>
        ))}
        {(planApproval ? todos.length > 0 : message.steps.length > 0) ? (
          <ol className="list-decimal space-y-1 pl-5">
            {planApproval
              ? todos.map((todo) => (
                  <li
                    key={todo.id}
                    className={todo.done ? "text-muted-foreground line-through" : ""}
                  >
                    {todo.text}
                  </li>
                ))
              : message.steps.map((step, index) => <li key={index}>{step}</li>)}
          </ol>
        ) : null}
        {expanded ? (
          <section data-request-details className="space-y-3">
            <dl className="space-y-2">
              {card.item.details?.map((detail, index) => (
                <div key={index}>
                  <dt className="text-xs text-muted-foreground">{detail.label}</dt>
                  <dd className="whitespace-pre-wrap wrap-break-word">{detail.text}</dd>
                </div>
              ))}
              {planApproval && todos.length > 0 ? (
                <div>
                  <dt className="text-xs text-muted-foreground">단계</dt>
                  <dd>
                    <ol className="list-decimal space-y-1 pl-5">
                      {todos.map((todo) => (
                        <li key={todo.id}>
                          {todo.doneWhen}
                          {todo.dependsOn.map((id) => {
                            const index = todos.findIndex((entry) => entry.id === id);
                            return index < 0 ? null : (
                              <span key={id} className="ml-2 text-muted-foreground">
                                {index + 1} 다음
                              </span>
                            );
                          })}
                        </li>
                      ))}
                    </ol>
                  </dd>
                </div>
              ) : null}
              {planApproval && nonGoals ? (
                <div>
                  <dt className="text-xs text-muted-foreground">안 하는 것</dt>
                  <dd className="whitespace-pre-wrap">{nonGoals}</dd>
                </div>
              ) : null}
            </dl>
            {!planApproval && card.item.options.length > 0 ? (
              <div className="space-y-2">
                <fieldset disabled={sending} className="space-y-2">
                  <legend className="sr-only">{message.headline}</legend>
                  {card.item.options.map((value) => {
                    const option = parseDecisionOption(value);
                    return (
                      <label key={value} className="flex items-start gap-2">
                        <input
                          type="radio"
                          name={`request-${card.item.id}`}
                          checked={picked === value}
                          onChange={() => setPicked(value)}
                          className="mt-1"
                        />
                        <span>
                          {option.label}
                          {option.recommended ? (
                            <span className="ml-2 text-xs text-primary">추천</span>
                          ) : null}
                          {option.tradeoff ? (
                            <span className="block text-xs text-muted-foreground">
                              {option.tradeoff}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
                <textarea
                  aria-label="Note for your answer"
                  data-decision-card-note
                  value={note}
                  disabled={sending}
                  rows={2}
                  onChange={(event) => setNote(event.target.value)}
                  className="w-full rounded-lg border bg-background px-3 py-2"
                />
                <Button
                  size="sm"
                  disabled={sending || picked === null}
                  onClick={() => {
                    if (picked !== null) {
                      submit(formatRequestAnswer(picked, note));
                    }
                  }}
                >
                  보내기
                </Button>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                disabled={!lead && chatThreadId === null}
                className="text-xs underline underline-offset-2"
                onClick={() => {
                  if (lead && related?.task.leadThreadId) {
                    setChatOpen(true);
                  } else if (chatThreadId !== null) {
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(scopeThreadRef(environmentId, chatThreadId)),
                    });
                  }
                }}
              >
                {lead ? "💬 리드와 대화" : "대화하기"}
              </button>
              {planApproval ? (
                <button
                  type="button"
                  className="text-xs underline underline-offset-2"
                  onClick={() => setReviewing(true)}
                >
                  전체 플랜
                </button>
              ) : null}
            </div>
          </section>
        ) : null}
        {failed ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            보내지 못했어요. 다시 시도해 주세요.
          </p>
        ) : null}
        <div data-request-actions className="flex gap-2 border-t border-border pt-3">
          <Button size="sm" disabled={sending} onClick={() => submit(approveAnswerFor(card.item))}>
            {card.item.kind === "blocker" ? REQUEST_BLOCKER_DONE : REQUEST_APPROVE_LABEL}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {REQUEST_DETAILS_LABEL}
          </Button>
        </div>
      </div>
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
        <Button
          size="xs"
          variant="ghost"
          disabled={composerRef === null}
          onClick={() => {
            if (composerRef !== null) {
              const store = useComposerDraftStore.getState();
              store.setPrompt(
                composerRef,
                `${link} ${store.getComposerDraft(composerRef)?.prompt ?? ""}`,
              );
              if (replyElsewhere) {
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(composerRef),
                });
              } else {
                // Typing continues after the link, not in front of it.
                window.requestAnimationFrame(() => composerHandle?.current?.focusAtEnd());
              }
            }
          }}
        >
          <ReplyIcon className="size-3" />
          답장
        </Button>
        <Button size="xs" variant="ghost" ref={copyRef} onClick={() => copyToClipboard(link)}>
          <CopyIcon className="size-3" />
          링크 복사
        </Button>
      </div>
      {planApproval ? (
        <PlanApprovalModal
          card={card}
          environmentId={environmentId}
          open={reviewing}
          onOpenChange={setReviewing}
          readOnly={false}
        />
      ) : null}
      <Dialog open={chatOpen} onOpenChange={setChatOpen}>
        <DialogPopup className="flex h-[75dvh] flex-col overflow-hidden p-0">
          <DialogTitle className="sr-only">리드와 대화</DialogTitle>
          {chatOpen ? <CardSideChat card={card} environmentId={environmentId} /> : null}
        </DialogPopup>
      </Dialog>
    </div>
  );
}
