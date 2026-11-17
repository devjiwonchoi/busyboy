import type { ProviderId } from './runner/contract'

// Harnesses a chat can run. A harness lists model and effort only when it
// accepts them. The picker offers a harness only while that provider is signed in.

export type HarnessField =
  | { id: 'model'; label: string; kind: 'text'; placeholder: string }
  | { id: 'effort'; label: string; kind: 'choice'; options: { value: string; label: string }[] }

export type Harness = {
  id: ProviderId
  name: string
  fields: HarnessField[]
}

const EFFORT = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
] as const

export const HARNESSES: Harness[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    fields: [
      { id: 'model', label: 'Model', kind: 'text', placeholder: 'sonnet' },
      {
        id: 'effort',
        label: 'Effort',
        kind: 'choice',
        // Claude Code also accepts `max` (see the Agent SDK's EffortLevel).
        options: [...EFFORT, { value: 'max', label: 'Max' }],
      },
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    fields: [
      { id: 'model', label: 'Model', kind: 'text', placeholder: 'gpt-5.4' },
      {
        id: 'effort',
        label: 'Effort',
        kind: 'choice',
        // Codex calls this the reasoning effort. `minimal` is its lowest.
        options: [{ value: 'minimal', label: 'Minimal' }, ...EFFORT],
      },
    ],
  },
  {
    id: 'grok',
    name: 'Grok',
    fields: [
      { id: 'model', label: 'Model', kind: 'text', placeholder: 'grok-4.5' },
      {
        id: 'effort',
        label: 'Effort',
        kind: 'choice',
        // Grok's reasoning effort. The CLI flag is `--reasoning-effort`.
        options: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ],
      },
    ],
  },
]

export function harnessById(id: string) {
  return HARNESSES.find((harness) => harness.id === id)
}

export function effortValues(id: ProviderId) {
  const field = harnessById(id)?.fields.find((entry) => entry.id === 'effort')
  return field?.kind === 'choice' ? field.options.map((option) => option.value) : []
}
