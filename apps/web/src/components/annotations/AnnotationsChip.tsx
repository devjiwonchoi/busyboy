import { MessageSquareTextIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export interface AnnotationSummary {
  readonly id: string;
  readonly quote: string;
  readonly comment: string;
}

/**
 * "N annotations": the composer-side view of the pins. Opens a list; choosing an entry jumps to
 * its pin and opens its pill.
 */
export function AnnotationsChip({
  annotations,
  noun,
  onOpen,
  onRemove,
}: {
  annotations: ReadonlyArray<AnnotationSummary>;
  /** Singular label, such as "annotation" or "comment". */
  noun: string;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (annotations.length === 0) return null;
  const label = `${annotations.length} ${noun}${annotations.length === 1 ? "" : "s"}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-annotations-chip
        render={
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 rounded-lg bg-background/60 font-normal"
          />
        }
      >
        <MessageSquareTextIcon aria-hidden="true" />
        {label}
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" width="md" padding="compact">
        <ol data-annotations-list className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {annotations.map((entry, index) => (
            <li key={entry.id} className="group flex items-start gap-1">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-start gap-2 rounded-md p-1.5 text-start text-sm hover:bg-accent"
                onClick={() => {
                  setOpen(false);
                  onOpen(entry.id);
                }}
              >
                <span
                  aria-hidden="true"
                  className="flex size-5 shrink-0 items-center justify-center rounded-full rounded-bl-none bg-blue-500 font-semibold text-[11px] text-white"
                >
                  {index + 1}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="line-clamp-2 text-muted-foreground text-xs">{entry.quote}</span>
                  {entry.comment ? (
                    <span className="whitespace-pre-wrap">{entry.comment}</span>
                  ) : null}
                </span>
              </button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${noun} ${index + 1}`}
                onClick={() => onRemove(entry.id)}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ol>
      </PopoverPopup>
    </Popover>
  );
}
