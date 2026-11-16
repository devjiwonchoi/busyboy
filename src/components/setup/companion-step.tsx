'use client'

import { useActionState, useState } from 'react'
import { chooseCompanionAction, removeCompanionImageAction, setCompanionImageAction } from '@/app/setup/actions'
import { CompanionAvatar } from '@/components/companion/companion-avatar'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FieldTitle } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { MAX_IMAGE_BYTES, MAX_IMAGE_TEXT } from '@/lib/companion-limits'
import type { Companion } from '@/server/companions'
import { StepFooter } from './step-footer'

const FORM_ID = 'companion-form'

export function CompanionStep({
  companions,
  selected,
  imageUrl,
}: {
  companions: Companion[]
  selected?: string
  /** The user's own picture, shown on the selected companion. */
  imageUrl?: string
}) {
  const [state, action, pending] = useActionState(chooseCompanionAction, {})
  const [value, setValue] = useState(selected)
  return (
    <>
      <form id={FORM_ID} action={action} className="space-y-3">
        <RadioGroup
          name="companion"
          aria-label="Companion"
          // null, not undefined, keeps the group controlled before the first choice.
          value={value ?? null}
          onValueChange={(next) => setValue(next as string)}
          className="grid-cols-1 sm:grid-cols-2"
        >
          {companions.map((companion) => (
            <FieldLabel key={companion.id} htmlFor={`companion-${companion.id}`}>
              <Field orientation="horizontal">
                <CompanionAvatar companion={companion} imageUrl={companion.id === value ? imageUrl : undefined} />
                <FieldContent>
                  <FieldTitle>
                    {companion.name} the {companion.animal}
                  </FieldTitle>
                  <FieldDescription>{companion.personality}</FieldDescription>
                </FieldContent>
                <RadioGroupItem value={companion.id} id={`companion-${companion.id}`} />
              </Field>
            </FieldLabel>
          ))}
        </RadioGroup>
        {state.error && <FieldError>{state.error}</FieldError>}
      </form>
      <CompanionImageForm hasImage={Boolean(imageUrl)} />
      <StepFooter>
        <Button type="submit" form={FORM_ID} disabled={pending || !value}>
          Continue
        </Button>
      </StepFooter>
    </>
  )
}

/** An optional picture of the user's own for their companion. It stays in the data folder. */
function CompanionImageForm({ hasImage }: { hasImage: boolean }) {
  const [state, action, pending] = useActionState(setCompanionImageAction, {})
  const [tooLarge, setTooLarge] = useState(false)
  // Checked before sending: a body over the server action limit fails before the action can explain why.
  const error = tooLarge ? `Choose a picture under ${MAX_IMAGE_TEXT}.` : state.error
  return (
    <form
      action={action}
      onSubmit={(event) => {
        const file = new FormData(event.currentTarget).get('image')
        const large = file instanceof File && file.size > MAX_IMAGE_BYTES
        setTooLarge(large)
        if (large) event.preventDefault()
      }}
    >
      <Field data-invalid={Boolean(error)}>
        <FieldLabel htmlFor="companion-image">Your own picture</FieldLabel>
        <FieldDescription>Optional. It stays on this computer, in the BusyBoy data folder.</FieldDescription>
        <div className="flex flex-wrap gap-2">
          <Input
            id="companion-image"
            name="image"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            aria-invalid={Boolean(error)}
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="outline" disabled={pending}>
            Use picture
          </Button>
          {hasImage && (
            <Button type="submit" variant="ghost" formAction={removeCompanionImageAction}>
              Remove picture
            </Button>
          )}
        </div>
        {error && <FieldError>{error}</FieldError>}
      </Field>
    </form>
  )
}
