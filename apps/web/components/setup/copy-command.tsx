"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";

export function CopyCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <InputGroup className="basis-full">
      <InputGroupTextarea
        aria-label={label}
        value={command}
        readOnly
        rows={1}
        spellCheck={false}
        className="min-h-0 font-mono"
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          aria-label={copied ? "Copied" : "Copy command"}
          onClick={async () => {
            const ok = await navigator.clipboard.writeText(command).then(
              () => true,
              () => false,
            );
            if (!ok) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check /> : <Copy />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
