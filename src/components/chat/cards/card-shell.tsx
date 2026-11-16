'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * The timeline card: a container, a header, a body, and a bottom-right action
 * row, composed from the Card primitive. Omit a part the card does not need.
 * `hoverActions` sits on the corner while the pointer is over the card; the
 * reply follow-up fills it and does not add a control to each kind.
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
      {hoverActions && (
        <div
          data-slot="card-hover-actions"
          className="absolute top-2 right-2 z-10 opacity-0 transition-opacity group-focus-within/timeline-card:opacity-100 group-hover/timeline-card:opacity-100"
        >
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
