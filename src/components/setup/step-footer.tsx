import Link from 'next/link'
import { stepHref, type StepId } from '@/app/setup/steps'
import { Button, buttonVariants } from '@/components/ui/button'

/** Back and the step's forward actions, at the bottom of every step. */
export function StepFooter({
  previous,
  hint,
  children,
}: {
  previous?: StepId
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t pt-6">
      {previous ? (
        <Link href={stepHref(previous)} className={buttonVariants({ variant: 'outline' })}>
          Back
        </Link>
      ) : (
        <Button variant="outline" disabled>
          Back
        </Button>
      )}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
        {hint && <p className="text-muted-foreground text-sm">{hint}</p>}
        {children}
      </div>
    </div>
  )
}
