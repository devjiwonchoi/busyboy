'use client'

import { useOptimistic, useTransition } from 'react'
import { setDefaultProviderAction } from '@/app/settings/actions'
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from '@/components/ui/field'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

export type HarnessOption = {
  id: string
  name: string
  /** Sign-in state, including when this harness is signed out. */
  status: string
  /** A signed-out or missing harness stays visible and cannot be chosen. */
  selectable: boolean
}

/** The harness every chat uses. Saved the moment it is chosen. */
export function HarnessChoice({ harnesses, selected }: { harnesses: HarnessOption[]; selected?: string }) {
  const [value, setValue] = useOptimistic(selected)
  const [, startTransition] = useTransition()
  return (
    <RadioGroup
      aria-label="Harness"
      value={value ?? null}
      onValueChange={(id) =>
        startTransition(async () => {
          setValue(id as string)
          await setDefaultProviderAction(id)
        })
      }
    >
      {harnesses.map(({ id, name, status, selectable }) => (
        <FieldLabel key={id} htmlFor={`harness-${id}`}>
          <Field orientation="horizontal" data-disabled={selectable ? undefined : true}>
            <FieldContent>
              <FieldTitle>Use {name} by default</FieldTitle>
              <FieldDescription>{status}</FieldDescription>
            </FieldContent>
            <RadioGroupItem value={id} id={`harness-${id}`} disabled={!selectable} />
          </Field>
        </FieldLabel>
      ))}
    </RadioGroup>
  )
}
