'use client'

import { CornerUpLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { useCardActionsOptional } from './card-actions'

/**
 * The timeline card: a container, a header, a body, and a bottom-right action
 * row, composed from the Card primitive. Omit a part the card does not need.
 * `hoverActions` sits on the corner while the pointer is over the card. Reply
 * is filled in there for an open card, so a kind does not add its own control.
 */
export function CardShell({
  label,
  replying = false,
  variant = 'panel',
  hoverActions,
  children,
}: {
  label: string
  replying?: boolean
  /** `line` is a single row, for a done card. `panel` is the full card. */
  variant?: 'panel' | 'line'
  hoverActions?: ReactNode
  children: ReactNode
}) {
  const actions = useCardActionsOptional()
  const replyHover = actions ? (
    <Button
      type="button"
      size="xs"
      variant="outline"
      className="bg-popover! shadow-sm"
      aria-pressed={actions.replying}
      onClick={() => actions.onReplyChange(!actions.replying)}
    >
      <CornerUpLeft />
      Reply
    </Button>
  ) : null
  const corner = replyHover || hoverActions
  return (
    <Card
      role="group"
      aria-label={label}
      data-replying={replying || undefined}
      data-variant={variant}
      size={variant === 'line' ? 'sm' : 'default'}
      className={cn(
        'group/timeline-card relative w-full',
        variant === 'line' && 'flex-row items-center',
        replying && 'ring-ring/50 ring-2',
      )}
    >
      {corner && (
        <div
          data-slot="card-hover-actions"
          className="pointer-events-none absolute top-3 right-3 z-20 flex items-center gap-1 opacity-0 transition-opacity group-focus-within/timeline-card:pointer-events-auto group-focus-within/timeline-card:opacity-100 group-hover/timeline-card:pointer-events-auto group-hover/timeline-card:opacity-100"
        >
          {replyHover}
          {hoverActions}
        </div>
      )}
      {children}
    </Card>
  )
}

export function CardShellHeader({ title, meta }: { title: ReactNode; meta?: ReactNode }) {
  return (
    <CardHeader>
      <CardTitle>{title}</CardTitle>
      {meta && <CardAction>{meta}</CardAction>}
    </CardHeader>
  )
}

export function CardShellBody({ children }: { children: ReactNode }) {
  return <CardContent className="space-y-2">{children}</CardContent>
}

/** Actions sit on the bottom right, under a divider. */
export function CardShellActions({ children }: { children: ReactNode }) {
  return <CardFooter className="justify-end gap-1 border-t">{children}</CardFooter>
}
