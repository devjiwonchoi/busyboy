'use client'

import { useActionState, useState } from 'react'
import { continueFromApprovalsAction, type FormResult } from '@/app/setup/actions'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'

/**
 * The always-ask list, one rule per line. The text is kept in state because a
 * form action resets its fields, which would throw away the user's edits when
 * a line is refused. The step footer's Continue submits it through `id`.
 */
export function AlwaysAskForm({ id, rules }: { id: string; rules: string[] }) {
  const [text, setText] = useState(rules.join('\n'))
  const [state, action] = useActionState<FormResult, FormData>(continueFromApprovalsAction, {})
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
        <FieldDescription>
          One rule per line: a tool name, a tool with what it runs such as Bash(gh pr merge*), Force push or delete a remote
          branch, or Delete outside the task folder. * matches anything. Changes apply to tasks started after you save.
        </FieldDescription>
      </Field>
    </form>
  )
}
