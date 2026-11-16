'use client'

import { useId, useState } from 'react'
import { approveCardAction } from '@/app/(main)/director-actions'
import { cardGroupLabel, type PlanCard } from '@/server/cards/model'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Markdown } from '../../markdown'
import type { CardViewProps } from '../card-view-props'
import { CardActionError, CardTrailingActions, useCardActions } from '../card-actions'
import { CardShell, CardShellActions, CardShellBody, CardShellHeader } from '../card-shell'

/**
 * A plan waiting for approval. The timeline shows the title, the short summary,
 * and the end-state list. View details opens the whole ALIGN.md in one pane.
 */
export function PlanCardView({ card }: CardViewProps<PlanCard>) {
  const { pending, replying, onReplyChange, run } = useCardActions()
  const [details, setDetails] = useState(false)
  const endStateId = useId()

  function approve() {
    setDetails(false)
    void run(() => approveCardAction(card.id), 'The plan could not be approved. Try again.')
  }

  function requestChanges() {
    setDetails(false)
    onReplyChange(true)
  }

  return (
    <CardShell label={cardGroupLabel(card)} replying={replying}>
      <CardShellHeader title={card.title} meta={`${card.project} · ${card.taskTitle}`} />
      <CardShellBody>
        <p>{card.summary}</p>
        {card.criteria.length > 0 && (
          <div className="space-y-1">
            <p id={endStateId} className="text-muted-foreground">
              End state
            </p>
            <ol aria-labelledby={endStateId} className="list-decimal space-y-1 pl-4">
              {card.criteria.map((item, index) => (
                <li key={`${index}-${item}`}>{item}</li>
              ))}
            </ol>
          </div>
        )}
        <CardActionError />
      </CardShellBody>
      <CardShellActions>
        <CardTrailingActions />
        <Button type="button" size="sm" variant="outline" onClick={() => setDetails(true)}>
          View details
        </Button>
        <Button type="button" size="sm" disabled={pending} onClick={approve}>
          Approve
        </Button>
      </CardShellActions>
      <Dialog open={details} onOpenChange={setDetails}>
        <DialogContent size="lg" className="overflow-hidden">
          <DialogHeader className="pr-8">
            <div className="flex flex-wrap items-center gap-2">
              <DialogDescription className="inline">
                {card.project} · {card.taskTitle}
              </DialogDescription>
              {/* Warning tint: this plan is still a draft waiting on the user. */}
              <Badge variant="outline" className="border-warning/40 bg-warning/10 text-warning-foreground">
                Waiting for approval
              </Badge>
            </div>
            <DialogTitle>{card.title}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto">
            <Markdown text={card.plan} />
          </div>
          <DialogFooter className="-mx-4 border-t px-4 pt-3">
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={requestChanges}>
              Request changes
            </Button>
            <Button type="button" size="sm" disabled={pending} onClick={approve}>
              Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CardShell>
  )
}
