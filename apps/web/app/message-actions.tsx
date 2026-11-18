"use client";

import { Check, Copy } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const COPIED_MS = 1500;

export function MessageActions({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  return (
    <div
      role="toolbar"
      aria-label="Message actions"
      className={cn(
        "w-fit opacity-0 pointer-events-none transition-opacity",
        "group-hover/message:pointer-events-auto group-hover/message:opacity-100",
        "group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100",
        "pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
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
