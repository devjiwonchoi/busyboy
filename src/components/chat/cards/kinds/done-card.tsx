'use client'

import { cardGroupLabel, type DoneCard } from '@/server/cards/model'
import type { CardViewProps } from '../card-view-props'
import { useCardActions } from '../card-actions'
import { CardShell, CardShellHeader } from '../card-shell'

/** One line once the task is finished: the task name, then Done. */
export function DoneCardView({ card }: CardViewProps<DoneCard>) {
  const { replying } = useCardActions()
  return (
    <CardShell label={cardGroupLabel(card)} replying={replying} variant="line">
      <CardShellHeader title={<span className="whitespace-nowrap">{card.taskTitle} · Done</span>} />
    </CardShell>
  )
}
