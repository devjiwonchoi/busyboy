'use client'

import { cardGroupLabel, type DoneCard } from '@/server/cards/model'
import type { CardViewProps } from '../card-view-props'
import { useCardActions } from '../card-actions'
import { CardShell, CardShellHeader } from '../card-shell'

/** A one-line card. The done follow-up replaces how the line is written. */
export function DoneCardView({ card }: CardViewProps<DoneCard>) {
  const { replying } = useCardActions()
  return (
    <CardShell label={cardGroupLabel(card)} replying={replying} variant="line">
      <CardShellHeader title={card.title} />
    </CardShell>
  )
}
