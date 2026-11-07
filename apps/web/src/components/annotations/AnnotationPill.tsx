import { CheckIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

/**
 * The floating comment box for one annotation, after Codex: a slim pill with ✓ for a new
 * annotation, a card with delete / Cancel / Save when editing a saved one.
 * Enter saves, Shift+Enter adds a line, Esc cancels.
 */
export function AnnotationPill({
  placed,
  isNew,
  draft,
  onDraftChange,
  onSave,
  onCancel,
  onDelete,
}: {
  /** False until the pill has its position; it cannot take focus while hidden. */
  placed: boolean;
  isNew: boolean;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const input = inputRef.current;
    if (!placed || !input) return;
    // A frame later, so a dialog's focus handling for the button that opened us has run.
    const frame = requestAnimationFrame(() => {
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [placed]);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSave();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };
  const input = (
    <textarea
      ref={inputRef}
      aria-label="Annotation comment"
      placeholder="Add an optional comment…"
      rows={1}
      value={draft}
      onChange={(event) => onDraftChange(event.currentTarget.value)}
      onKeyDown={onKeyDown}
      className={cn(
        "field-sizing-content block max-h-40 min-w-0 flex-1 resize-none bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm",
        isNew ? "py-1.5" : "min-h-10 w-full py-1",
      )}
    />
  );
  return (
    <div
      role="dialog"
      aria-label={isNew ? "New annotation" : "Edit annotation"}
      data-annotation-pill={isNew ? "new" : "edit"}
      className={cn(
        "border border-border/70 bg-popover text-popover-foreground shadow-lg",
        isNew ? "flex items-end gap-1 rounded-3xl py-1 ps-4 pe-1" : "rounded-2xl px-4 pt-3 pb-2",
      )}
      // Keep events away from chat shortcuts and the dialog's Esc handler.
      onKeyDown={(event) => event.stopPropagation()}
    >
      {isNew ? (
        <>
          {input}
          <Button
            size="icon-sm"
            className="shrink-0 rounded-full"
            aria-label="Save annotation"
            onPointerDown={(event) => event.preventDefault()}
            onClick={onSave}
          >
            <CheckIcon />
          </Button>
        </>
      ) : (
        <>
          {input}
          <div className="mt-2 flex items-center gap-1.5">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Delete annotation"
              onPointerDown={(event) => event.preventDefault()}
              onClick={onDelete}
            >
              <Trash2Icon />
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="ms-auto rounded-full"
              onPointerDown={(event) => event.preventDefault()}
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="rounded-full"
              onPointerDown={(event) => event.preventDefault()}
              onClick={onSave}
            >
              Save
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
