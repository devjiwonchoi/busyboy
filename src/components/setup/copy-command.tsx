'use client'

import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'

/** A shell command the user runs themselves, with a copy button. */
export function CopyCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <InputGroup className="basis-full">
      {/* A read-only text area grows to fit, so long commands wrap instead of being cut off. */}
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
          aria-label={copied ? 'Copied' : 'Copy command'}
          onClick={async () => {
            // Copying can be refused (no permission or no focus); the command stays visible to copy by hand.
            const ok = await navigator.clipboard.writeText(command).then(
              () => true,
              () => false,
            )
            if (!ok) return
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? <Check /> : <Copy />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}
