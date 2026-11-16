'use client'

import { useOptimistic, useTransition } from 'react'
import { setDefaultProviderAction } from '@/app/settings/actions'
import { Field, FieldContent, FieldLabel, FieldTitle } from '@/components/ui/field'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

/** Which signed-in agent new chats and tasks use, saved the moment it is chosen. */
export function DefaultAgent({ agents, selected }: { agents: { id: string; name: string }[]; selected?: string }) {
  const [value, setValue] = useOptimistic(selected)
  const [, startTransition] = useTransition()
  return (
    <RadioGroup
      aria-label="Default agent"
      value={value ?? null}
      onValueChange={(id) =>
        startTransition(async () => {
          setValue(id as string)
          await setDefaultProviderAction(id)
        })
      }
    >
      {agents.map(({ id, name }) => (
        <FieldLabel key={id} htmlFor={`default-${id}`}>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Use {name} by default</FieldTitle>
            </FieldContent>
            <RadioGroupItem value={id} id={`default-${id}`} />
          </Field>
        </FieldLabel>
      ))}
    </RadioGroup>
  )
}
