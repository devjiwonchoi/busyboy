'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'

export function CardShell({
  label,
  replying = false,
  variant = 'panel',
  hoverActions,
  children,
}: {
  label: string
  replying?: boolean
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
        variant === 'line' && 'flex-row items-center [&_[data-slot=card-header]]:w-full',
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

export function CardShellActions({ children }: { children: ReactNode }) {
  return <CardFooter className="justify-end gap-1 border-t">{children}</CardFooter>
}
