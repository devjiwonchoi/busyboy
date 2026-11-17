"use client";

import { Check, Copy, Pencil, RotateCcw } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useExternalSync } from "@/hooks/use-external-sync";
import { cn } from "@/lib/utils";

function formatMessageTime(at: string) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

export function MessageActions({
  text,
  at,
  align,
  onEdit,
  onRetry,
}: {
  text: string;
  at: string;
  align: "start" | "end";
  onEdit?: () => void;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const time = formatMessageTime(at);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useExternalSync(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div
      role="toolbar"
      aria-label="Message actions"
      className={cn(
        "pointer-events-none absolute bottom-0 z-10 flex items-center gap-1 opacity-0 transition-opacity",
        "group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100",
        "group-hover/message:pointer-events-auto group-hover/message:opacity-100",
        "pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
        align === "end" ? "right-full flex-row-reverse pr-1" : "left-full pl-1",
      )}
    >
      {time && (
        <time
          dateTime={at}
          className="text-muted-foreground px-1 text-[0.625rem] leading-none tabular-nums whitespace-nowrap"
        >
          {time}
        </time>
      )}
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={copied ? "Copied" : "Copy"}
        onClick={() => void copy()}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
      {onEdit && (
        <Button type="button" size="icon-xs" variant="ghost" aria-label="Edit" onClick={onEdit}>
          <Pencil />
        </Button>
      )}
      {onRetry && (
        <Button type="button" size="icon-xs" variant="ghost" aria-label="Retry" onClick={onRetry}>
          <RotateCcw />
        </Button>
      )}
    </div>
  );
}
