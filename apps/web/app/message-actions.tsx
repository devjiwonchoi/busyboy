"use client";

import { Check, Copy } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const COPIED_MS = 1500;

export function MessageActions({
  text,
  align,
  hovered,
}: {
  text: string;
  align: "start" | "end";
  hovered: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  return (
    <div
      role="toolbar"
      aria-label="Message actions"
      className={cn(
        "absolute bottom-0 z-10 flex items-center transition-opacity",
        hovered ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
        "group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100",
        "pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
        align === "end" ? "right-full pr-1" : "left-full pl-1",
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={copied ? "Copied" : "Copy"}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(
            () => {
              setCopied(true);
              if (copiedTimer.current) clearTimeout(copiedTimer.current);
              copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
            },
            () => setCopied(false),
          );
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}
