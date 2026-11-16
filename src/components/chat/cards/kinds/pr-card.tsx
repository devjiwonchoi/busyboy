'use client'

import { cardGroupLabel, type PrCard } from '@/server/cards/model'
import type { CardViewProps } from '../card-view-props'
import { CardActionError, CardTrailingActions, useCardActions } from '../card-actions'
import { CardShell, CardShellActions, CardShellBody, CardShellHeader } from '../card-shell'

/** One row per pull request. The pull-request follow-up replaces the rows and the merge action. */
export function PrCardView({ card }: CardViewProps<PrCard>) {
  const { replying } = useCardActions()
  return (
    <CardShell label={cardGroupLabel(card)} replying={replying}>
      <CardShellHeader title={card.title} />
      <CardShellBody>
        <ul className="space-y-1">
          {card.pulls.map((pull) => (
            <li key={pull.number} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate">
                #{pull.number} {pull.title}
              </span>
              <span className="text-muted-foreground shrink-0">{pull.review}</span>
            </li>
          ))}
        </ul>
        {card.note && <p className="text-muted-foreground">{card.note}</p>}
        <CardActionError />
      </CardShellBody>
      <CardShellActions>
        <CardTrailingActions />
      </CardShellActions>
    </CardShell>
  )
}
