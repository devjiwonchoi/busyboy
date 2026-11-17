'use client'

import { useState } from 'react'
import { setChatHarnessAction } from '@/app/(main)/harness-actions'
import { Input } from '@/components/ui/input'
import { HARNESSES, harnessById } from '@/server/harness'
import type { ChatHarness } from '@/server/chat-harness'
import type { ProviderId } from '@/server/runner/contract'

const controlClass =
  'h-6 rounded-md border border-input bg-transparent px-1.5 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30'

/**
 * The harness for this chat, on the composer toolbar. Model and effort show
 * only when that harness accepts them. The choice is stored for this chat.
 */
export function HarnessPicker({
  chat,
  fallback,
  initial,
  offered,
}: {
  chat: string | null
  /** Used when this chat has no choice of its own yet. */
  fallback: ProviderId
  initial: ChatHarness | null
  /** Providers this chat may choose. Grok is listed only while it is signed in. */
  offered: ProviderId[]
}) {
  const choices = HARNESSES.filter((harness) => offered.includes(harness.id))
  const starting =
    initial && offered.includes(initial.provider)
      ? initial
      : { provider: offered.includes(fallback) ? fallback : (choices[0]?.id ?? fallback) }
  const [choice, setChoice] = useState<ChatHarness>(starting)
  const [error, setError] = useState(false)
  const harness = harnessById(choice.provider) ?? HARNESSES[0]
  const modelField = harness?.fields.find((field) => field.id === 'model')
  const effortField = harness?.fields.find((field) => field.id === 'effort')

  function save(next: ChatHarness) {
    setChoice(next)
    setError(false)
    void setChatHarnessAction(chat, next).catch(() => setError(true))
  }

  return (
    <div role="group" aria-label="Harness" data-provider={choice.provider} className="flex min-w-0 flex-wrap items-center gap-1">
      <select
        aria-label="Harness"
        className={controlClass}
        value={choice.provider}
        onChange={(event) => {
          const provider = event.target.value as ProviderId
          const nextHarness = harnessById(provider)
          const effortStillValid =
            choice.effort && nextHarness?.fields.some((field) => field.id === 'effort' && field.kind === 'choice' && field.options.some((option) => option.value === choice.effort))
          save({
            provider,
            ...(choice.model && nextHarness?.fields.some((field) => field.id === 'model') ? { model: choice.model } : {}),
            ...(effortStillValid ? { effort: choice.effort } : {}),
          })
        }}
      >
        {choices.map(({ id, name }) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
      {modelField?.kind === 'text' && (
        <Input
          aria-label={modelField.label}
          placeholder={modelField.placeholder}
          value={choice.model ?? ''}
          className="h-6 w-28"
          onChange={(event) => setChoice({ ...choice, model: event.target.value })}
          onBlur={(event) => save({ ...choice, model: event.target.value })}
          onKeyDown={(event) => {
            // The composer sends on Enter. This field only stores the model.
            if (event.key !== 'Enter') return
            event.preventDefault()
            event.stopPropagation()
            event.currentTarget.blur()
          }}
        />
      )}
      {effortField?.kind === 'choice' && (
        <select
          aria-label={effortField.label}
          className={controlClass}
          value={choice.effort ?? ''}
          onChange={(event) => save({ ...choice, effort: event.target.value })}
        >
          <option value="">Default</option>
          {effortField.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
      {error && <span className="text-destructive text-xs">Could not save.</span>}
    </div>
  )
}
