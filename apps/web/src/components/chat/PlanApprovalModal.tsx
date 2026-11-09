import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  type EnvironmentId,
  formatPlanApproval,
  formatPlanReviewFeedback,
  planApprovalOutcome,
  type PlanReviewComment,
  type ProjectDecisionCard,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { TOUCH_SELECTION_ACTION_GAP } from "~/lib/selectionActions";
import { cn, randomUUID } from "~/lib/utils";
import { useAnswerDecision, useTaskDetail } from "~/state/projectTeam";
import {
  AnnotationOverlay,
  type AnnotationEditing,
  scrollAnnotationIntoView,
} from "../annotations/AnnotationOverlay";
import { AnnotationsChip } from "../annotations/AnnotationsChip";
import { Button } from "../ui/button";
import { Dialog, DialogBackdrop, DialogPortal, DialogTitle, DialogViewport } from "../ui/dialog";
import { DIALOG_POPUP_CLASS } from "../ui/dialog-styles";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { diffWords } from "./planDiff";
import { TaskParentBreadcrumb, TaskStructure, useTaskRelations } from "../task/TaskRelations";
import {
  PlanBreakdown,
  PlanCriteria,
  PlanFileTree,
  PlanFlow,
  PlanPrototype,
  PlanSectionHeading,
} from "../plan/PlanDocument";
import { PlanTodoList } from "../plan/PlanTodoList";
import { PlanApprovalSections, PlanMarkdown, PlanSummary } from "./PlanMarkdown";
import { AttentionContext, useAttentionTask } from "./AttentionContext";

/** A text selection in the plan, waiting for the Comment button. */
interface PendingSelection {
  readonly section: string;
  readonly quote: string;
  /** Where the quote starts in its section's text, to find the right copy of repeated text. */
  readonly start: number;
  /** The selection's box, relative to the plan body. */
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly bodyWidth: number;
  /** True when the Comment button fits above the selection inside the visible plan. */
  readonly roomAbove: boolean;
  /** Made by touch: the phone's own copy menu sits above, so the button goes below. */
  readonly touch: boolean;
}

/** An inline comment on the plan: a pin on its quote, edited in the annotation pill. */
interface PlanAnnotation extends PlanReviewComment {
  readonly id: string;
  readonly start: number;
}

/** Height of the floating Comment button plus its gap to the selection. */
const COMMENT_BUTTON_OFFSET = 34;
const COMMENT_BUTTON_WIDTH = 96;

const OUTCOME_STATUS = {
  start: "Approved and started",
  approve_only: "Approved",
  changes: "Changes requested",
} as const;

/** The plan section the user selected text in, or null outside the plan body. */
function readPlanSelection(body: HTMLElement, touch: boolean): PendingSelection | null {
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
  const raw = range.toString();
  const quote = raw.trim();
  if (quote.length === 0) return null;
  const before = document.createRange();
  before.setStart(sectionElement, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const rect = range.getBoundingClientRect();
  const bodyRect = body.getBoundingClientRect();
  const visibleTop = Math.max(
    bodyRect.top,
    body.closest("[data-plan-scroll]")?.getBoundingClientRect().top ?? bodyRect.top,
  );
  return {
    section: sectionElement.dataset.planSection ?? "",
    quote,
    start: before.toString().length + (raw.length - raw.trimStart().length),
    top: rect.top - bodyRect.top,
    bottom: rect.bottom - bodyRect.top,
    left: rect.left - bodyRect.left,
    bodyWidth: bodyRect.width,
    roomAbove: rect.top - visibleTop >= COMMENT_BUTTON_OFFSET,
    touch,
  };
}

/** The Comment button: above the selection (below without room), inside the body. */
function commentButtonPosition(pending: PendingSelection) {
  return {
    top: pending.touch
      ? pending.bottom + TOUCH_SELECTION_ACTION_GAP
      : pending.roomAbove
        ? pending.top - COMMENT_BUTTON_OFFSET
        : pending.bottom + 6,
    left: Math.max(0, Math.min(pending.left, pending.bodyWidth - COMMENT_BUTTON_WIDTH)),
  };
}

/** The range of `quote` in `root`'s text, taking the copy closest to `start`. */
function findQuoteRange(root: HTMLElement, quote: string, start: number): Range | null {
  const nodes: Text[] = [];
  const offsets: number[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    nodes.push(node as Text);
    offsets.push(text.length);
    text += node.nodeValue ?? "";
  }
  let best = -1;
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
    if (best < 0 || Math.abs(at - start) < Math.abs(best - start)) best = at;
  }
  if (best < 0) return null;
  // The start lands in the node that holds its first character; the end in the node that
  // holds its last one.
  const locate = (offset: number, isEnd: boolean) => {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      const relative = offset - offsets[index]!;
      if (isEnd ? relative <= node.length && node.length > 0 : relative < node.length) {
        return { node, offset: relative };
      }
    }
    return null;
  };
  const from = locate(best, false);
  const to = locate(best + quote.length, true);
  if (!from || !to) return null;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
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
  const relations = useTaskRelations(environmentId, card.item.taskId);
  const { related, projectId, projectTitle } = useAttentionTask({ card, environmentId });
  const running = related?.task.stage === "running";
  const query = useTaskDetail(environmentId, {
    projectId,
    taskId: card.item.taskId,
  });
  const answerDecision = useAnswerDecision();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overlayHost, setOverlayHost] = useState<HTMLDivElement | null>(null);
  const [viewed, setViewed] = useState<number | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  const [comments, setComments] = useState<ReadonlyArray<PlanAnnotation>>([]);
  const [editing, setEditing] = useState<AnnotationEditing>(null);
  const [overall, setOverall] = useState("");
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [sending, setSending] = useState(false);

  // How the last press was made, and whether it was on the Comment button: a phone can clear
  // the selection before the tap lands, which must not take the button away.
  const pressRef = useRef({ touch: false, onComment: false });

  // Track the selection in the plan body for the Comment button.
  useEffect(() => {
    const onSelectionChange = () => {
      const body = bodyRef.current;
      if (body === null || pressRef.current.onComment) return;
      setPending(readPlanSelection(body, pressRef.current.touch));
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary) return;
      pressRef.current = {
        touch: event.pointerType !== "mouse",
        onComment:
          event.target instanceof Element &&
          event.target.closest("[data-plan-comment-button]") !== null,
      };
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
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
  // A just-added comment whose pill is still open is not part of the feedback yet.
  const savedComments = comments.filter((entry) => !(editing?.isNew && editing.id === entry.id));
  const notes = { comments: savedComments, overall };
  const hasFeedback = savedComments.length > 0 || overall.trim().length > 0;

  const captureSelection = () => {
    const body = bodyRef.current;
    if (body === null || !canComment || pressRef.current.onComment) return;
    setPending(readPlanSelection(body, pressRef.current.touch));
  };

  const addComment = () => {
    if (pending === null) return;
    const id = randomUUID();
    setComments([
      ...comments,
      { id, section: pending.section, quote: pending.quote, start: pending.start, comment: "" },
    ]);
    setEditing({ id, isNew: true });
    setPending(null);
    pressRef.current.onComment = false;
    window.getSelection()?.removeAllRanges();
  };

  const resolveRange = (
    id: string,
    host: ParentNode | undefined = bodyRef.current ?? undefined,
  ) => {
    const entry = comments.find((comment) => comment.id === id);
    const section = host?.querySelector<HTMLElement>(
      `[data-plan-section="${CSS.escape(entry?.section ?? "")}"]`,
    );
    return entry && section ? findQuoteRange(section, entry.quote, entry.start) : null;
  };

  const openComment = (id: string) => {
    const range = resolveRange(id);
    if (range) scrollAnnotationIntoView(range);
    setEditing({ id, isNew: false });
  };

  const removeComment = (id: string) => {
    setComments(comments.filter((entry) => entry.id !== id));
    if (editing?.id === id) setEditing(null);
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

  const sectionHeading = (label: string) => <PlanSectionHeading>{label}</PlanSectionHeading>;
  const structured = spec.summary.trim().length > 0;
  // A section that only has something to show outside the diff view.
  const extraSection = (label: string, content: ReactNode, show: boolean) =>
    show && !diffing ? (
      <section key={label} className="mt-6" data-plan-part={label}>
        {sectionHeading(label)}
        {content}
      </section>
    ) : null;

  const textSection = (
    label: string,
    field: "background" | "summary" | "goal" | "successCriteria" | "nonGoals",
  ) => {
    const text = spec[field].trim();
    const before = previous?.spec[field].trim() ?? "";
    return (
      <section key={field} className="mt-6 first:mt-0">
        {sectionHeading(label)}
        <div
          data-plan-section={label}
          className={cn(
            "text-sm leading-relaxed",
            diffing && "whitespace-pre-wrap",
            text.length === 0 && !diffing && "text-muted-foreground",
          )}
        >
          {diffing ? (
            <DiffText before={before} after={text} />
          ) : text.length === 0 ? (
            "—"
          ) : (
            <PlanMarkdown text={text} />
          )}
        </div>
      </section>
    );
  };

  const steps = (
    <section className="mt-6">
      {sectionHeading("Steps")}
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
        <PlanTodoList todos={spec.todos} running={running} />
      )}
    </section>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col gap-1.5 border-b px-5 pt-4 pb-3 md:px-7">
        <div className="flex flex-wrap items-center gap-2 pe-8">
          <span data-plan-meta className="font-mono text-muted-foreground text-xs">
            {projectTitle} ({detail.key})
          </span>
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
        <TaskParentBreadcrumb relations={relations} />
        <DialogTitle data-plan-title className="font-semibold text-2xl leading-tight">
          {title}
        </DialogTitle>
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

      <div ref={setOverlayHost} className="relative flex min-h-0 flex-1 flex-col">
        <div data-plan-scroll className="min-h-0 flex-1 overflow-y-auto">
          <div
            ref={bodyRef}
            className="relative mx-auto w-full max-w-4xl min-w-0 px-5 pt-8 pb-5 md:px-7"
            data-plan-body
            data-plan-version={shown.version}
            onMouseUp={captureSelection}
            onTouchEnd={captureSelection}
          >
            <AttentionContext context={card.item.context} planApproval />
            {structured ? (
              diffing ? (
                textSection("Summary", "summary")
              ) : (
                <PlanSummary text={spec.summary} />
              )
            ) : (
              <PlanApprovalSections item={card.item} className="gap-6" />
            )}
            <div className="mt-6">
              {structured ? steps : null}
              {textSection("End result", "goal")}
              {diffing ? null : (
                <PlanPrototype html={spec.prototype} waiver={spec.prototypeWaiver} />
              )}
              {extraSection("Flow", <PlanFlow source={spec.flow} />, spec.flow.trim().length > 0)}
              {spec.criteria.length > 0 && !diffing
                ? extraSection("Success criteria", <PlanCriteria criteria={spec.criteria} />, true)
                : textSection("Success criteria", "successCriteria")}
              {textSection("Non-goals", "nonGoals")}
              {structured ? null : steps}
              {extraSection(
                "Breakdown",
                <PlanBreakdown todos={spec.todos} running={running} />,
                spec.todos.some((todo) => todo.dependsOn.length > 0),
              )}
              {extraSection(
                "Files",
                <PlanFileTree files={spec.files} todos={spec.todos} />,
                spec.files.length > 0,
              )}
            </div>
            <TaskStructure relations={relations} className="mt-6" />
            {spec.background.trim().length > 0 ? (
              <details className="mt-6 text-sm">
                <summary className="cursor-pointer select-none font-semibold text-sm">
                  Background
                </summary>
                <PlanMarkdown text={spec.background} className="mt-1.5 text-muted-foreground" />
              </details>
            ) : null}
            {canComment && pending !== null && editing === null ? (
              <div
                data-plan-comment-button
                className="absolute z-20"
                style={commentButtonPosition(pending)}
              >
                <Button
                  size="xs"
                  variant="outline"
                  // Solid even on hover: the outline style is see-through in dark mode, and this sits on text.
                  className="bg-popover shadow-lg dark:bg-popover [:hover,[data-pressed]]:bg-popover dark:[:hover,[data-pressed]]:bg-popover"
                  // Keep the selection when the button takes the press.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={addComment}
                >
                  Comment
                </Button>
              </div>
            ) : null}
          </div>
        </div>
        {canComment ? (
          <AnnotationOverlay
            host={overlayHost}
            annotations={comments}
            resolveRange={resolveRange}
            editing={editing}
            onEdit={(id) => setEditing({ id, isNew: false })}
            onSave={(id, comment) => {
              setComments(
                comments.map((entry) => (entry.id === id ? { ...entry, comment } : entry)),
              );
              setEditing(null);
            }}
            onCancel={(id, isNew) => (isNew ? removeComment(id) : setEditing(null))}
            onDelete={removeComment}
          />
        ) : null}
      </div>

      {canAnswer ? (
        <footer className="flex shrink-0 flex-col gap-2 border-t bg-muted/40 px-5 py-3 md:px-7">
          <Textarea
            aria-label="Overall comment"
            placeholder="Overall comment (optional)"
            size="sm"
            className="[&_textarea]:min-h-10 max-md:[&_textarea]:min-h-10"
            value={overall}
            onChange={(event) => setOverall(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <AnnotationsChip
              annotations={savedComments}
              noun="comment"
              onOpen={openComment}
              onRemove={removeComment}
            />
            <div className="ms-auto flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!hasFeedback || sending}
                onClick={() =>
                  send(formatPlanReviewFeedback({ specVersion: reviewVersion.version, ...notes }))
                }
              >
                Request changes
              </Button>
              <Button size="sm" disabled={sending} onClick={() => send(formatPlanApproval(notes))}>
                Approve
              </Button>
            </div>
          </div>
        </footer>
      ) : null}
    </div>
  );
}
