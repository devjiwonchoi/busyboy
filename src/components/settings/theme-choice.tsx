'use client'

import { useOptimistic, useTransition } from 'react'
import { setThemeAction } from '@/app/settings/actions'
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from '@/components/ui/field'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { rememberTheme, type ThemeName } from '@/lib/theme'

const CHOICES: { id: ThemeName; title: string; description: string }[] = [
  { id: 'system', title: 'System', description: 'Follow this device.' },
  { id: 'dark', title: 'Dark', description: 'The default.' },
  { id: 'light', title: 'Light', description: 'A light background.' },
]

export function ThemeChoice({ selected }: { selected: ThemeName }) {
  const [value, setValue] = useOptimistic(selected)
  const [, startTransition] = useTransition()
  return (
    <RadioGroup
      aria-label="Theme"
      value={value}
      onValueChange={(id) =>
        startTransition(async () => {
          const theme = id as ThemeName
          setValue(theme)
          rememberTheme(theme)
          await setThemeAction(theme)
        })
      }
    >
      {CHOICES.map(({ id, title, description }) => (
        <FieldLabel key={id} htmlFor={`theme-${id}`}>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>{title}</FieldTitle>
              <FieldDescription>{description}</FieldDescription>
            </FieldContent>
            <RadioGroupItem value={id} id={`theme-${id}`} />
          </Field>
        </FieldLabel>
      ))}
    </RadioGroup>
  )
}
