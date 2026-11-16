'use client'

import { useActionState, useState } from 'react'
import { chooseCompanionAction, removeCompanionImageAction, setCompanionImageAction } from '@/app/setup/actions'
import { CompanionAvatar } from '@/components/companion/companion-avatar'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { MAX_IMAGE_BYTES, MAX_IMAGE_TEXT } from '@/lib/companion-limits'
import { cn } from '@/lib/utils'
import type { Companion } from '@/server/companions'
import { StepFooter } from './step-footer'

const FORM_ID = 'companion-form'

export function CompanionStep({
  companions,
  selected,
  defaultId,
  imageUrl,
}: {
  companions: Companion[]
  selected?: string
  /** Checked until the user picks, and until a choice has been saved. */
  defaultId: string
  /** The user's own picture, shown on the selected companion. */
  imageUrl?: string
}) {
  const [state, action, pending] = useActionState(chooseCompanionAction, {})
  const [value, setValue] = useState(selected ?? defaultId)
  const chosen = companions.find((companion) => companion.id === value)
  return (
    <>
      <form id={FORM_ID} action={action} className="space-y-3">
        <CompanionChoices companions={companions} value={value} imageUrl={imageUrl} onChange={setValue} />
        {state.error && <FieldError>{state.error}</FieldError>}
      </form>
      <CompanionImageForm hasImage={Boolean(imageUrl)} />
      <StepFooter>
        <Button type="submit" form={FORM_ID} disabled={pending || !chosen}>
          {chosen ? `Continue with ${chosen.name}` : 'Continue'}
        </Button>
      </StepFooter>
      <CharacterNote />
    </>
  )
}

/** The characters as a radio row, shared by setup (saved on Continue) and settings (saved on choice). */
export function CompanionChoices({
  companions,
  value,
  imageUrl,
  onChange,
}: {
  companions: Companion[]
  value?: string
  imageUrl?: string
  onChange: (id: string) => void
}) {
  return (
    <RadioGroup
      name="companion"
      aria-label="Director"
      // null, not undefined, keeps the group controlled before the first choice.
      value={value ?? null}
      onValueChange={(next) => onChange(next as string)}
      className="grid-cols-2 gap-3 sm:grid-cols-5"
    >
      {companions.map((companion) => (
        <RadioGroupItem
          key={companion.id}
          value={companion.id}
          aria-label={`${companion.name} the ${companion.animal}`}
          className="h-auto w-full cursor-pointer flex-col items-center gap-2 rounded-xl border-border/70 bg-card p-3 text-center after:hidden aspect-auto data-checked:border-violet-500 data-checked:bg-violet-500/10 data-checked:text-foreground data-checked:ring-2 data-checked:ring-violet-500 dark:data-checked:bg-violet-500/15"
        >
          <CompanionAvatar
            companion={companion}
            imageUrl={companion.id === value ? imageUrl : undefined}
            className="size-16 text-3xl [&_[data-slot=avatar-fallback]]:text-3xl"
          />
          <span className="text-sm font-medium">{companion.name}</span>
          <span className="text-muted-foreground text-xs font-normal">{companion.animal}</span>
        </RadioGroupItem>
      ))}
    </RadioGroup>
  )
}

/** Shown under the picker. The emoji are stand-ins for illustrated characters. */
export function CharacterNote({ className }: { className?: string }) {
  return <p className={cn('text-muted-foreground text-center text-xs', className)}>Temporary emoji stand in for character art.</p>
}

/** An optional picture of the user's own for their companion. It stays in the data folder. */
export function CompanionImageForm({ hasImage }: { hasImage: boolean }) {
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
