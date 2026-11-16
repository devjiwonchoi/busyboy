'use client'

import { Quote, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * The composer target, in the composer's leading slot: a compact chip. A reply
 * quotes the card; a message to a task names it. The dismiss control returns
 * the composer to the Director.
 */
export function ReplyTarget({
  mode,
  target,
  directorName,
  onClear,
}: {
  mode: 'reply' | 'message'
  target: string
  directorName: string
  onClear: () => void
}) {
  const replying = mode === 'reply'
  return (
    <div
      role="group"
      aria-label={replying ? `Replying to ${target}` : `Messaging ${target}`}
      className="bg-muted text-foreground flex min-w-0 items-center gap-1.5 rounded-md py-0.5 pr-0.5 pl-2 text-xs ring-1 ring-foreground/10"
    >
      {replying && <Quote className="text-muted-foreground size-3 shrink-0" aria-hidden />}
      <span className="min-w-0 truncate">{replying ? `“${target}”` : `Messaging ${target}`}</span>
      <Button type="button" size="icon-xs" variant="ghost" aria-label={`Message ${directorName} instead`} onClick={onClear}>
        <X />
      </Button>
    </div>
  )
}
