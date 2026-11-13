'use client'

import { useActionState } from 'react'
import { addTypedProjectAction, type FormResult } from '@/app/setup/actions'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

// Typing or pasting a path works everywhere, including a plain browser without the desktop bridge.
export function AddProjectForm() {
  const [state, action, pending] = useActionState<FormResult, FormData>(addTypedProjectAction, {})
  return (
    <form action={action}>
      <Field data-invalid={Boolean(state.error)}>
        <FieldLabel htmlFor="project-folder">Folder path</FieldLabel>
        <div className="flex gap-2">
          <Input
            id="project-folder"
            name="folder"
            required
            placeholder="~/code/my-app"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(state.error)}
            aria-describedby={state.error ? 'project-folder-error' : undefined}
            className="font-mono"
          />
          <Button type="submit" variant="outline" disabled={pending}>
            Add folder
          </Button>
        </div>
        {state.error && <FieldError id="project-folder-error">{state.error}</FieldError>}
      </Field>
    </form>
  )
}
