'use client'

import { Check, Copy, Pencil, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

function formatMessageTime(at: string) {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
}

/**
 * Time, copy, edit, and retry for one message. Message and Bubble have no
 * actions slot, so this row goes in the MessageFooter under the bubble and
 * shows while the message is hovered or focused, and always on touch screens.
 * It stays in the layout while hidden so hovering does not shift the chat.
 */
export function MessageActions({
  text,
  at,
  align,
  onEdit,
  onRetry,
}: {
  text: string
  at: string
  align: 'start' | 'end'
  onEdit?: () => void
  onRetry?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const time = formatMessageTime(at)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div
      role="toolbar"
      aria-label="Message actions"
      className={cn(
        'pointer-events-none flex items-center gap-0.5 opacity-0 transition-opacity',
        'group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100',
        'group-hover/message:pointer-events-auto group-hover/message:opacity-100',
        'pointer-coarse:pointer-events-auto pointer-coarse:opacity-100',
        align === 'end' && 'flex-row-reverse',
      )}
    >
      {time && (
        <time dateTime={at} className="text-muted-foreground px-1 text-[0.625rem] tabular-nums">
          {time}
        </time>
      )}
      <Button type="button" size="icon-xs" variant="ghost" aria-label={copied ? 'Copied' : 'Copy'} onClick={() => void copy()}>
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
  )
}
