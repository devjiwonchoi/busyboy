'use client'

import { useState } from 'react'
import { Check, Circle } from 'lucide-react'
import { cardGroupLabel, type ProgressCard, type ProgressStepState } from '@/server/cards/model'
import { PhaseMark } from '../../phase-mark'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import type { CardViewProps } from '../card-view-props'
import { useCardActions } from '../card-actions'
import { CardShell, CardShellActions, CardShellBody, CardShellHeader } from '../card-shell'

const STATE_WORD: Record<ProgressStepState, string> = {
  done: 'Done',
  running: 'Running',
  pending: 'Not started',
}

/** A filled green check, a spinner, or an empty circle. */
function StepMark({ state }: { state: ProgressStepState }) {
  if (state === 'done') {
    return (
      <span data-step-mark="done" className="bg-success flex size-3.5 shrink-0 items-center justify-center rounded-full text-white" aria-hidden>
        <Check className="size-2.5" strokeWidth={3} />
      </span>
    )
  }
  if (state === 'running') {
    return <Spinner data-step-mark="running" aria-hidden className="text-muted-foreground size-3.5" />
  }
  return <Circle data-step-mark="pending" className="text-muted-foreground/60 size-3.5 shrink-0" aria-hidden />
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

/** Steps of a task that is underway. The only action is View details. */
export function ProgressCardView({ card }: CardViewProps<ProgressCard>) {
  const { replying } = useCardActions()
  const [details, setDetails] = useState(false)
  return (
    <CardShell label={cardGroupLabel(card)} replying={replying}>
      <CardShellHeader
        title={<span className="font-semibold">{card.title}</span>}
        meta={
          <span className="text-muted-foreground inline-flex items-center gap-2 text-xs font-normal">
            <span>{card.project}</span>
            <PhaseMark phase={card.phase} />
          </span>
        }
      />
      <CardShellBody>
        <StepList steps={card.steps} />
      </CardShellBody>
      <CardShellActions>
        <button type="button" className="text-muted-foreground cursor-pointer border-0 bg-transparent p-0 text-xs font-normal" onClick={() => setDetails(true)}>
          View details
        </button>
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
