import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  type EnvironmentId,
  PLAN_APPROVAL_ONLY,
  PLAN_APPROVAL_START,
  formatPlanReviewFeedback,
  planApprovalOutcome,
  type PlanReviewComment,
  type ProjectDecisionCard,
  type ProjectTaskSpec,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { useIsMobile } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { useAnswerDecision, useTaskDetail } from "~/state/projectTeam";
import { Button } from "../ui/button";
import { Dialog, DialogBackdrop, DialogPortal, DialogTitle, DialogViewport } from "../ui/dialog";
import { DIALOG_POPUP_CLASS } from "../ui/dialog-styles";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { diffWords } from "./planDiff";

/** A text selection in the plan, waiting for its comment. */
interface PendingSelection {
  readonly section: string;
  readonly quote: string;
  /** Position under the selection, relative to the plan body. */
  readonly top: number;
  readonly left: number;
  readonly editing: boolean;
}

const OUTCOME_STATUS = {
  start: "Approved and started",
  approve_only: "Approved",
  changes: "Changes requested",
} as const;

/** The plan section the user selected text in, or null outside the plan body. */
function readPlanSelection(body: HTMLElement): PendingSelection | null {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const start =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const sectionElement = start?.closest<HTMLElement>("[data-plan-section]") ?? null;
  if (sectionElement === null || !body.contains(sectionElement)) return null;
  // A triple click can run into the next block; keep the quote inside one section.
  if (!sectionElement.contains(range.endContainer)) {
    range.setEnd(sectionElement, sectionElement.childNodes.length);
  }
  const quote = range.toString().trim();
  if (quote.length === 0) return null;
  const rect = range.getBoundingClientRect();
  const bodyRect = body.getBoundingClientRect();
  return {
    section: sectionElement.dataset.planSection ?? "",
    quote,
    top: rect.bottom - bodyRect.top + 6,
    left: Math.max(0, Math.min(rect.left - bodyRect.left, bodyRect.width - 120)),
    editing: false,
  };
}

/** Wraps the first match of each quote in <mark>. */
function withHighlights(text: string, quotes: ReadonlyArray<string>): ReactNode {
  const ranges: Array<[number, number]> = [];
  for (const quote of quotes) {
    const at = text.indexOf(quote);
    if (at < 0) continue;
    const end = at + quote.length;
    if (ranges.some(([from, to]) => at < to && end > from)) continue;
    ranges.push([at, end]);
  }
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => a[0] - b[0]);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const [from, to] of ranges) {
    if (from > cursor) nodes.push(text.slice(cursor, from));
    nodes.push(
      <mark key={from} className="rounded-sm bg-warning/30 text-inherit">
        {text.slice(from, to)}
      </mark>,
    );
    cursor = to;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function DiffText({ before, after }: { before: string; after: string }) {
  return diffWords(before, after).map((part, index) =>
    part.kind === "insert" ? (
      <ins
        key={index}
        data-diff="insert"
        className="rounded-sm bg-success/20 text-success-foreground no-underline"
      >
        {part.text}
      </ins>
    ) : part.kind === "delete" ? (
      <del
        key={index}
        data-diff="delete"
        className="rounded-sm bg-destructive/10 text-destructive-foreground line-through"
      >
        {part.text}
      </del>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );
}

/**
 * The plan review: the spec version under review laid out like an issue, with inline
 * comments on selected text and the approve / request changes answer. Full screen on phones.
 */
export function PlanApprovalModal(props: {
  card: ProjectDecisionCard;
  environmentId: EnvironmentId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  readOnly: boolean;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogViewport className="max-md:p-0">
          <DialogPrimitive.Popup
            className={cn(
              DIALOG_POPUP_CLASS,
              "row-start-2 h-[90dvh] w-[min(96vw,72rem)] overflow-hidden text-popover-foreground",
              "max-md:h-dvh max-md:w-screen max-md:rounded-none max-md:border-0",
            )}
            data-plan-review={props.card.item.id}
          >
            <PlanReview {...props} />
          </DialogPrimitive.Popup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}

function PlanReview({
  card,
  environmentId,
  onOpenChange,
  readOnly,
}: {
  card: ProjectDecisionCard;
  environmentId: EnvironmentId;
  onOpenChange: (open: boolean) => void;
  readOnly: boolean;
}) {
  const query = useTaskDetail(environmentId, {
    projectId: card.item.projectId,
    taskId: card.item.taskId,
  });
  const answerDecision = useAnswerDecision();
  const isMobile = useIsMobile();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [viewed, setViewed] = useState<number | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  const [comments, setComments] = useState<ReadonlyArray<PlanReviewComment>>([]);
  const [overall, setOverall] = useState("");
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [draftComment, setDraftComment] = useState("");
  const [sending, setSending] = useState(false);

  // Track the selection in the plan body; an open comment editor keeps its selection.
  useEffect(() => {
    const onSelectionChange = () => {
      const body = bodyRef.current;
      if (body === null) return;
      setPending((current) => (current?.editing ? current : readPlanSelection(body)));
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  const detail = query.data;
  const title = card.taskTitle;
  if (detail === null) {
    return (
      <>
        <DialogTitle className="sr-only">{`Plan approval · ${title}`}</DialogTitle>
        <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
          {query.error ?? "Loading plan…"}
        </div>
      </>
    );
  }

  const versions = detail.versions;
  const latest = versions.at(-1)!;
  const reviewVersion =
    versions.find((version) => version.version === card.item.specVersion) ?? latest;
  const shown = versions.find((version) => version.version === viewed) ?? reviewVersion;
  const previous = versions.find((version) => version.version === shown.version - 1) ?? null;
  const diffing = showChanges && previous !== null;
  const canAnswer = !readOnly && shown.version === reviewVersion.version;
  const canComment = canAnswer && !diffing;
  const spec = shown.spec;
  const outcome = card.item.answer === null ? null : planApprovalOutcome(card.item.answer);
  const status = !readOnly
    ? "Waiting for approval"
    : outcome !== null
      ? OUTCOME_STATUS[outcome]
      : "Closed";
  const versionLabel = (version: number) =>
    version === reviewVersion.version
      ? `v${version} · reviewing`
      : version === latest.version
        ? `v${version} · latest`
        : `v${version}`;
  const hasFeedback = comments.length > 0 || overall.trim().length > 0;

  const captureSelection = () => {
    const body = bodyRef.current;
    if (body === null || !canComment) return;
    setPending((current) => (current?.editing ? current : readPlanSelection(body)));
  };

  const saveComment = () => {
    const text = draftComment.trim();
    if (pending === null || text.length === 0) return;
    setComments([...comments, { section: pending.section, quote: pending.quote, comment: text }]);
    setPending(null);
    setDraftComment("");
    window.getSelection()?.removeAllRanges();
  };

  const cancelComment = () => {
    setPending(null);
    setDraftComment("");
  };

  const send = (answer: string) => {
    if (sending) return;
    setSending(true);
    void answerDecision(environmentId, {
      projectId: card.item.projectId,
      attentionItemId: card.item.id,
      answer,
    }).then((result) => {
      setSending(false);
      if (AsyncResult.isSuccess(result)) onOpenChange(false);
    });
  };

  const quotesFor = (section: string) =>
    comments.filter((entry) => entry.section === section).map((entry) => entry.quote);

  const textSection = (label: string, field: keyof Omit<ProjectTaskSpec, "todos">) => {
    const text = spec[field].trim();
    const before = previous?.spec[field].trim() ?? "";
    return (
      <section key={field} className="mt-6 first:mt-0">
        <h3 className="mb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
          {label}
        </h3>
        <div
          data-plan-section={label}
          className={cn(
            "whitespace-pre-wrap text-sm leading-relaxed",
            text.length === 0 && !diffing && "text-muted-foreground",
          )}
        >
          {diffing ? (
            <DiffText before={before} after={text} />
          ) : text.length === 0 ? (
            "—"
          ) : canComment ? (
            withHighlights(text, quotesFor(label))
          ) : (
            text
          )}
        </div>
      </section>
    );
  };

  const steps = (
    <section className="mt-6">
      <h3 className="mb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
        Steps
      </h3>
      {diffing ? (
        <div data-plan-section="Steps" className="whitespace-pre-wrap text-sm leading-relaxed">
          <DiffText
            before={previous!.spec.todos.map((todo) => todo.text).join("\n")}
            after={spec.todos.map((todo) => todo.text).join("\n")}
          />
        </div>
      ) : spec.todos.length === 0 ? (
        <p className="text-muted-foreground text-sm">—</p>
      ) : (
        <ol
          data-plan-section="Steps"
          className="flex list-decimal flex-col gap-1 ps-5 text-sm leading-relaxed"
        >
          {spec.todos.map((todo) => (
            <li key={todo.id} className={cn(todo.done && "text-muted-foreground line-through")}>
              {canComment ? withHighlights(todo.text, quotesFor("Steps")) : todo.text}
            </li>
          ))}
        </ol>
      )}
    </section>
  );

  const commentEditor =
    pending === null ? null : pending.editing ? (
      <div className="flex flex-col gap-2 rounded-lg border bg-popover p-2 shadow-md">
        <p className="line-clamp-2 border-l-2 border-warning/60 ps-2 text-muted-foreground text-xs">
          {pending.quote}
        </p>
        <Textarea
          aria-label="Comment"
          autoFocus
          size="sm"
          value={draftComment}
          onChange={(event) => setDraftComment(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) saveComment();
          }}
        />
        <div className="flex justify-end gap-1.5">
          <Button size="xs" variant="ghost" onClick={cancelComment}>
            Cancel
          </Button>
          <Button size="xs" disabled={draftComment.trim().length === 0} onClick={saveComment}>
            Save comment
          </Button>
        </div>
      </div>
    ) : (
      <Button
        size="xs"
        variant="outline"
        className="shadow-md"
        // Keep the selection when the button takes the press.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setPending({ ...pending, editing: true })}
      >
        Comment
      </Button>
    );

  const commentList = (
    <div className="flex flex-col gap-2" data-plan-comments>
      <h3 className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
        Comments{comments.length > 0 ? ` · ${comments.length}` : ""}
      </h3>
      {comments.length === 0 ? (
        <p className="text-muted-foreground text-xs">Select text in the plan to comment on it.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {comments.map((entry, index) => (
            <li
              // Comments have no id; their order is stable until one is removed.
              key={`${index}:${entry.quote}`}
              data-plan-comment
              className="rounded-lg border bg-card/60 p-2 text-sm"
            >
              <div className="flex items-start gap-2">
                <span className="text-[11px] text-muted-foreground">{entry.section}</span>
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  className="ml-auto"
                  aria-label="Remove comment"
                  onClick={() => setComments(comments.filter((_, at) => at !== index))}
                >
                  <XIcon />
                </Button>
              </div>
              <p className="mt-1 line-clamp-3 border-l-2 border-warning/60 ps-2 text-muted-foreground text-xs">
                {entry.quote}
              </p>
              <p className="mt-1 whitespace-pre-wrap">{entry.comment}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col gap-2 border-b px-5 pt-4 pb-3 md:px-7">
        <div className="flex flex-wrap items-center gap-2 pe-8">
          <span className="font-mono text-muted-foreground text-sm">{detail.key}</span>
          <span
            data-plan-status
            className={cn(
              "rounded-full border px-2 py-0.5 text-xs",
              readOnly ? "text-muted-foreground" : "text-warning-foreground",
            )}
          >
            {status}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              aria-pressed={showChanges}
              disabled={previous === null}
              data-pressed={showChanges || undefined}
              onClick={() => setShowChanges(!showChanges)}
            >
              {showChanges ? "Hide changes" : "Show changes"}
            </Button>
            <Select
              value={String(shown.version)}
              onValueChange={(value) => {
                setViewed(Number(value));
                setPending(null);
              }}
            >
              <SelectTrigger size="xs" aria-label="Plan version" className="min-w-0">
                <SelectValue>{versionLabel(shown.version)}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {versions.map((version) => (
                  <SelectItem key={version.version} value={String(version.version)}>
                    {versionLabel(version.version)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </div>
        <DialogTitle className="text-xl leading-tight">{title}</DialogTitle>
        {!readOnly && shown.version !== reviewVersion.version ? (
          <p role="status" className="text-muted-foreground text-xs">
            Viewing v{shown.version}, read-only. You are reviewing v{reviewVersion.version}.{" "}
            <button
              type="button"
              className="text-foreground underline underline-offset-2"
              onClick={() => setViewed(null)}
            >
              Back to v{reviewVersion.version}
            </button>
          </p>
        ) : null}
        <DialogPrimitive.Close
          aria-label="Close"
          className="absolute end-2 top-2"
          render={<Button size="icon" variant="ghost" />}
        >
          <XIcon />
        </DialogPrimitive.Close>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            "grid gap-6 px-5 py-5 md:px-7",
            canComment && "md:grid-cols-[minmax(0,1fr)_17rem]",
          )}
        >
          <div
            ref={bodyRef}
            className="relative min-w-0"
            data-plan-body
            data-plan-version={shown.version}
            onMouseUp={captureSelection}
            onTouchEnd={captureSelection}
          >
            {textSection("End result", "goal")}
            {textSection("Success criteria", "successCriteria")}
            {textSection("Non-goals", "nonGoals")}
            {steps}
            {spec.background.trim().length > 0 ? (
              <details className="mt-6 text-sm">
                <summary className="cursor-pointer select-none font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
                  Background
                </summary>
                <p className="mt-1.5 whitespace-pre-wrap text-muted-foreground leading-relaxed">
                  {spec.background}
                </p>
              </details>
            ) : null}
            {canComment && !isMobile && commentEditor !== null ? (
              <div
                className="absolute z-10 w-72 max-w-full"
                style={{ top: pending!.top, left: pending!.left }}
              >
                {commentEditor}
              </div>
            ) : null}
          </div>
          {canComment ? <aside className="min-w-0 md:border-l md:ps-5">{commentList}</aside> : null}
        </div>
      </div>

      {canAnswer ? (
        <footer className="flex shrink-0 flex-col gap-2 border-t bg-muted/40 px-5 py-3 md:px-7">
          {canComment && isMobile && commentEditor !== null ? (
            <div data-plan-mobile-comment>{commentEditor}</div>
          ) : null}
          <Textarea
            aria-label="Overall comment"
            placeholder="Overall comment (optional)"
            size="sm"
            className="[&_textarea]:min-h-10 max-md:[&_textarea]:min-h-10"
            value={overall}
            onChange={(event) => setOverall(event.target.value)}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!hasFeedback || sending}
              onClick={() =>
                send(
                  formatPlanReviewFeedback({
                    specVersion: reviewVersion.version,
                    comments,
                    overall,
                  }),
                )
              }
            >
              Request changes
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={sending}
              onClick={() => send(PLAN_APPROVAL_ONLY)}
            >
              Approve only
            </Button>
            <Button size="sm" disabled={sending} onClick={() => send(PLAN_APPROVAL_START)}>
              Approve and start
            </Button>
          </div>
        </footer>
      ) : null}
    </div>
  );
}
