'use client'

import { useActionState, useState } from 'react'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'

export type AlwaysAskResult = { error?: string; saved?: boolean }

/**
 * The always-ask list, one rule per line. The text is kept in state because a
 * form action resets its fields, which would throw away the user's edits when
 * a line is refused. A button outside the form submits it through `id`: setup's
 * Continue, which saves and goes on, or settings' Save, which stays.
 */
export function AlwaysAskForm({
  id,
  rules,
  save,
}: {
  id: string
  rules: string[]
  save: (previous: AlwaysAskResult, form: FormData) => Promise<AlwaysAskResult>
}) {
  const [text, setText] = useState(rules.join('\n'))
  const [state, action] = useActionState<AlwaysAskResult, FormData>(save, {})
  return (
    <form id={id} action={action}>
      <Field data-invalid={Boolean(state.error)}>
        <FieldLabel htmlFor="always-ask-rules">Always-ask list</FieldLabel>
        <Textarea
          id="always-ask-rules"
          name="rules"
          rows={14}
          spellCheck={false}
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-invalid={Boolean(state.error)}
          aria-describedby={state.error ? 'always-ask-error' : undefined}
          className="font-mono"
        />
        {state.error && <FieldError id="always-ask-error">{state.error}</FieldError>}
        {state.saved && !state.error && (
          <p role="status" className="text-muted-foreground text-sm">
            Saved.
          </p>
        )}
        <FieldDescription>
          One rule per line: a tool name, a tool with what it runs such as Bash(gh pr merge*), Force push or delete a remote
          branch, or Delete outside the task folder. * matches anything. Changes apply to tasks started after you save.
        </FieldDescription>
      </Field>
    </form>
  )
}
