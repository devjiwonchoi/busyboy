// The setup steps, in order. The current step lives in the URL (`?step=`), so
// Back, Continue, and reloads all land on the same step without client state.

export const STEPS = [
  { id: 'companion', title: 'Companion' },
  { id: 'agents', title: 'Agents' },
  { id: 'skills', title: 'Skills' },
  { id: 'approvals', title: 'Approvals' },
  { id: 'start', title: 'Start' },
] as const

export type StepId = (typeof STEPS)[number]['id']

export function parseStep(value: unknown): StepId {
  return STEPS.find(({ id }) => id === value)?.id ?? 'companion'
}

export function stepHref(id: StepId) {
  return id === 'companion' ? '/setup' : `/setup?step=${id}`
}

export function neighborSteps(id: StepId) {
  const index = STEPS.findIndex((step) => step.id === id)
  return { previous: STEPS[index - 1]?.id, next: STEPS[index + 1]?.id }
}
