'use client'

import { useState } from 'react'
import { approveCardAction } from '@/app/(main)/director-actions'
import { cardGroupLabel, type PlanCard } from '@/server/cards/model'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Markdown } from '../../markdown'
import type { CardViewProps } from '../card-view-props'
import { CardActionError, CardTrailingActions, useCardActions } from '../card-actions'
import { CardShell, CardShellActions, CardShellBody, CardShellHeader } from '../card-shell'

/**
 * The plan card as it works today: summary, Approve, and the ALIGN.md dialog.
 * The plan follow-up replaces the body (the criteria list) and the dialog's
 * contents; it keeps this file.
 */
export function PlanCardView({ card }: CardViewProps<PlanCard>) {
  const { pending, replying, run } = useCardActions()
  const [details, setDetails] = useState(false)
  return (
    <CardShell label={cardGroupLabel(card)} replying={replying}>
      <CardShellHeader title={card.title} meta={`${card.project} · ${card.taskTitle}`} />
      <CardShellBody>
        <p>{card.summary}</p>
        <CardActionError />
      </CardShellBody>
      <CardShellActions>
        <Button type="button" size="sm" variant="outline" onClick={() => setDetails(true)}>
          View details
        </Button>
        <Button type="button" size="sm" disabled={pending} onClick={() => run(() => approveCardAction(card.id), 'The plan could not be approved. Try again.')}>
          Approve
        </Button>
        <CardTrailingActions />
      </CardShellActions>
      <Dialog open={details} onOpenChange={setDetails}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Plan: {card.title}</DialogTitle>
            <DialogDescription>
              {card.project} · {card.taskTitle}
            </DialogDescription>
          </DialogHeader>
          <Markdown text={card.plan} />
        </DialogContent>
      </Dialog>
    </CardShell>
  )
}
