import { cn } from '@/lib/utils'
import { PHASE_WORD, type TaskPhase } from '@/server/records/task-phase'

// The same colors as the task-row badges: blue is in progress, amber needs a person, green is done.
const TONE: Record<TaskPhase, string> = {
  planning: 'text-info-foreground',
  working: 'text-info-foreground',
  verifying: 'text-info-foreground',
  aligning: 'text-warning-foreground',
  'needs-you': 'text-warning-foreground',
  done: 'text-success-foreground',
  pr: 'text-success-foreground',
  stopped: 'text-destructive',
  idle: 'text-muted-foreground',
}

/** A dot and one phase word. The task row, the project pill, and the cards share it. */
export function PhaseMark({ phase, className, status }: { phase: TaskPhase; className?: string; status?: string }) {
  return (
    <span
      data-phase={phase}
      data-status={status}
      className={cn('inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap', TONE[phase], className)}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />
      {PHASE_WORD[phase]}
    </span>
  )
}
