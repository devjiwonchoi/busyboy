'use client'

import { useState } from 'react'
import { Check, Circle } from 'lucide-react'
import { cardGroupLabel, type ProgressCard, type ProgressStepState } from '@/server/cards/model'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import type { CardViewProps } from '../card-view-props'
import { CardActionError, CardTrailingActions, useCardActions } from '../card-actions'
import { CardShell, CardShellActions, CardShellBody, CardShellHeader } from '../card-shell'

const STATE_WORD: Record<ProgressStepState, string> = {
  done: 'Done',
  running: 'Running',
  pending: 'Not started',
}

/** A filled check, a spinner, or an empty circle, one per step. */
function StepMark({ state }: { state: ProgressStepState }) {
  if (state === 'done') {
    return (
      <span data-step-mark="done" className="bg-success flex size-4 shrink-0 items-center justify-center rounded-full text-white" aria-hidden>
        <Check className="size-2.5" strokeWidth={3} />
      </span>
    )
  }
  if (state === 'running') {
    return <Spinner data-step-mark="running" aria-hidden className="text-status-running" />
  }
  return <Circle data-step-mark="pending" className="text-muted-foreground/70 size-4 shrink-0" aria-hidden />
}

function StepList({ steps, spelled }: { steps: ProgressCard['steps']; spelled?: boolean }) {
  return (
    <ol className="space-y-1.5">
      {steps.map((step) => (
        <li key={step.id} className="flex items-center gap-2" data-state={step.state}>
          <StepMark state={step.state} />
          <span className="sr-only">{STATE_WORD[step.state]}: </span>
          <span className="min-w-0">{step.label}</span>
          {spelled && <span className="text-muted-foreground ml-auto shrink-0">{STATE_WORD[step.state]}</span>}
        </li>
      ))}
    </ol>
  )
}

/** Steps of a task that is underway: a check on each finished step and a spinner on the one running. */
export function ProgressCardView({ card }: CardViewProps<ProgressCard>) {
  const { replying } = useCardActions()
  const [details, setDetails] = useState(false)
  return (
    <CardShell label={cardGroupLabel(card)} replying={replying}>
      <CardShellHeader title={card.title} />
      <CardShellBody>
        <StepList steps={card.steps} />
        <CardActionError />
      </CardShellBody>
      <CardShellActions>
        <Button type="button" size="sm" variant="outline" onClick={() => setDetails(true)}>
          View details
        </Button>
        <CardTrailingActions />
      </CardShellActions>
      <Dialog open={details} onOpenChange={setDetails}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{card.title}</DialogTitle>
            <DialogDescription>
              {card.project} · {card.taskTitle}
            </DialogDescription>
          </DialogHeader>
          <StepList steps={card.steps} spelled />
        </DialogContent>
      </Dialog>
    </CardShell>
  )
}
