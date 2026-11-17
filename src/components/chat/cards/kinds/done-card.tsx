'use client'

import { useState } from 'react'
import { Check } from 'lucide-react'
import { readTaskPlanAction } from '@/app/(main)/director-actions'
import { cardGroupLabel, type DoneCard } from '@/server/cards/model'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Markdown } from '../../markdown'
import type { CardViewProps } from '../card-view-props'
import { useCardActions } from '../card-actions'
import { CardShell, CardShellHeader } from '../card-shell'

/** One compact line: a check, the task name, Done, and a link to the plan. */
export function DoneCardView({ card }: CardViewProps<DoneCard>) {
  const { replying } = useCardActions()
  const [open, setOpen] = useState(false)
  const [plan, setPlan] = useState<{ title: string; plan: string } | null>(null)
  const [missing, setMissing] = useState(false)

  async function viewPlan() {
    setOpen(true)
    setMissing(false)
    try {
      const result = await readTaskPlanAction(card.taskId)
      if (!result) setMissing(true)
      else setPlan(result)
    } catch {
      setMissing(true)
    }
  }

  return (
    <CardShell label={cardGroupLabel(card)} replying={replying} variant="line">
      <CardShellHeader
        title={
          <span className="inline-flex items-center gap-2 whitespace-nowrap">
            <span className="bg-success flex size-3.5 shrink-0 items-center justify-center rounded-full text-white" aria-hidden>
              <Check className="size-2.5" strokeWidth={3} />
            </span>
            <span className="font-semibold">{card.taskTitle}</span>
            <span className="text-muted-foreground font-normal"> · Done</span>
          </span>
        }
        meta={
          <button
            type="button"
            className="text-muted-foreground cursor-pointer border-0 bg-transparent p-0 text-xs font-normal underline underline-offset-2"
            onClick={() => void viewPlan()}
          >
            View plan
          </button>
        }
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{plan?.title ?? card.taskTitle}</DialogTitle>
            <DialogDescription>{card.project}</DialogDescription>
          </DialogHeader>
          {plan ? <Markdown text={plan.plan} /> : missing ? <p>The plan could not be read.</p> : null}
        </DialogContent>
      </Dialog>
    </CardShell>
  )
}
