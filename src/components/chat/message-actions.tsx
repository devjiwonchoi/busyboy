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
        'pointer-events-none absolute top-0 z-10 flex items-center gap-0.5 rounded-full border border-border bg-popover/95 p-0.5 opacity-0 shadow-sm transition-opacity',
        'group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100',
        'group-hover/message:pointer-events-auto group-hover/message:opacity-100',
        align === 'end' ? 'right-0' : 'left-0',
      )}
    >
      {time && (
        <time dateTime={at} className="text-muted-foreground px-1.5 text-[0.625rem] tabular-nums">
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
