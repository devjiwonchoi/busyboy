import Link from 'next/link'
import { STEPS, stepHref, type StepId } from '@/app/setup/steps'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

// No library (shadcn, @coss, @spell) has a stepper, so the step pills are
// links styled as buttons with a numbered badge, joined by separators.
export function SetupSteps({ current }: { current: StepId }) {
  return (
    <nav aria-label="Setup steps">
      <ol className="flex flex-wrap items-center gap-1">
        {STEPS.map((step, index) => {
          const active = step.id === current
          return (
            <li key={step.id} className="flex items-center gap-1">
              {index > 0 && <Separator aria-hidden className="data-horizontal:w-4" />}
              <Link
                href={stepHref(step.id)}
                aria-current={active ? 'step' : undefined}
                className={buttonVariants({ variant: active ? 'secondary' : 'ghost', size: 'sm' })}
              >
                <Badge variant={active ? 'default' : 'outline'}>{index + 1}</Badge>
                {step.title}
              </Link>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
