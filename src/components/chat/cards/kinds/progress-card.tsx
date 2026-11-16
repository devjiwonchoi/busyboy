'use client'

import { cardGroupLabel, type ProgressCard } from '@/server/cards/model'
import type { CardViewProps } from '../card-view-props'
import { CardActionError, CardTrailingActions, useCardActions } from '../card-actions'
import { CardShell, CardShellActions, CardShellBody, CardShellHeader } from '../card-shell'

/** Plain steps. The progress follow-up replaces this body with status marks and its own actions. */
export function ProgressCardView({ card }: CardViewProps<ProgressCard>) {
  const { replying } = useCardActions()
  return (
    <CardShell label={cardGroupLabel(card)} replying={replying}>
      <CardShellHeader title={card.title} />
      <CardShellBody>
        <ol className="space-y-1">
          {card.steps.map((step) => (
            <li key={step.id}>{step.label}</li>
          ))}
        </ol>
        <CardActionError />
      </CardShellBody>
      <CardShellActions>
        <CardTrailingActions />
      </CardShellActions>
    </CardShell>
  )
}
