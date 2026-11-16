// MCP elicitation forms (`mcpServer/elicitation/request` in `form` mode) as
// question cards, and the answers back as typed form content. The contract's
// questions only offer choices, so a field becomes a question when it has a
// fixed set of values (an enum, a titled enum, a boolean, a multi-select);
// other fields take their default. Types follow codex-cli 0.167.0
// (`McpElicitationSchema`), the MCP 2025-11-25 form schema.
import type { AgentAnswer, Question } from './contract'

type Choice = { const: string; title: string }

/** One property of a requested form schema, reduced to the fields read here. */
export type ElicitationField = {
  type?: string
  title?: string
  description?: string
  default?: unknown
  enum?: string[]
  enumNames?: string[]
  oneOf?: Choice[]
  items?: { enum?: string[]; anyOf?: Choice[] }
}

export type ElicitationSchema = { properties?: Record<string, ElicitationField | undefined>; required?: string[] }

/** The option that declines the whole form, offered on every question unless a field already has a choice by that name. */
export const DECLINE_LABEL = "Don't send the form"
const YES = 'Yes'
const NO = 'No'

type FormQuestion = { key: string; field: ElicitationField; question: Question; choices: Choice[] }

function choicesOf(field: ElicitationField): Choice[] {
  if (field.type === 'boolean') return [{ const: 'true', title: YES }, { const: 'false', title: NO }]
  if (field.type === 'array' && field.items?.anyOf) return field.items.anyOf
  if (field.oneOf) return field.oneOf
  const values = field.type === 'array' ? (field.items?.enum ?? []) : (field.enum ?? [])
  return values.map((value, index) => ({ const: value, title: field.enumNames?.[index] ?? value }))
}

/** The fields that become questions, in schema order. The first question carries the form's message. */
function formQuestions(message: string, schema: ElicitationSchema): FormQuestion[] {
  const questions: FormQuestion[] = []
  for (const [key, field] of Object.entries(schema.properties ?? {})) {
    if (!field) continue
    const choices = choicesOf(field)
    if (choices.length === 0) continue
    const name = field.title || key
    const text = field.description ? `${name}: ${field.description}` : name
    questions.push({
      key,
      field,
      choices,
      question: {
        question: questions.length === 0 && message ? `${message} ${text}` : text,
        multiSelect: field.type === 'array',
        options: [
          ...choices.map((choice) => ({ label: choice.title })),
          ...(choices.some((choice) => choice.title === DECLINE_LABEL) ? [] : [{ label: DECLINE_LABEL }]),
        ],
      },
    })
  }
  return questions
}

/**
 * Required fields BusyBoy cannot ask for: they take free text or a number and
 * have no default. A form with any of them cannot be filled in here.
 */
export function unfillableFields(schema: ElicitationSchema) {
  const properties = schema.properties ?? {}
  return (schema.required ?? []).filter((key) => {
    const field = properties[key]
    return !field || (choicesOf(field).length === 0 && field.default === undefined)
  })
}

/** What a form sends without asking: each field's default, as `Title: value` lines. */
export function elicitationDefaults(schema: ElicitationSchema) {
  return Object.entries(schema.properties ?? {})
    .filter(([, field]) => field?.default !== undefined)
    .map(([key, field]) => `${field?.title || key}: ${JSON.stringify(field?.default)}`)
}

/** The questions for a form, or none when it has no field with choices. */
export function elicitationQuestions(message: string, schema: ElicitationSchema): Question[] {
  return formQuestions(message, schema).map(({ question }) => question)
}

/**
 * Splits a multi-select answer (labels joined with ", ") back into labels, even
 * when a label has a comma. Undefined when any part is not one of the labels.
 */
function selectedLabels(answer: string, choices: Choice[]) {
  if (answer === '') return []
  const labels = new Set(choices.map((choice) => choice.title))
  const selected: string[] = []
  let current: string | undefined
  for (const piece of answer.split(', ')) {
    current = current === undefined ? piece : `${current}, ${piece}`
    if (labels.has(current)) {
      selected.push(current)
      current = undefined
    }
  }
  return current === undefined ? selected : undefined
}

/**
 * The form content for an answer, or undefined when the form is declined: the
 * user chose Decline, an answer is not one of its question's choices, or a
 * required field is still empty. Unanswered fields take their default.
 *
 * An answer that matches no choice declines rather than being skipped: the
 * Director answers every question with a "No answer..." text, and skipping it
 * would send the form with its defaults (say, `action: delete`) that no one saw.
 */
export function elicitationContent(
  message: string,
  schema: ElicitationSchema,
  answer: AgentAnswer,
): Record<string, unknown> | undefined {
  if (answer.kind !== 'question') return undefined
  const content: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(schema.properties ?? {})) {
    if (field?.default !== undefined) content[key] = field.default
  }
  for (const { key, field, question, choices } of formQuestions(message, schema)) {
    const label = answer.answers[question.question]
    if (label === undefined) continue
    const ownDecline = choices.some((choice) => choice.title === DECLINE_LABEL)
    const labels = field.type === 'array' ? selectedLabels(label, [...choices, { const: '', title: DECLINE_LABEL }]) : [label]
    if (!labels || (!ownDecline && labels.includes(DECLINE_LABEL))) return undefined
    const values = labels.map((title) => choices.find((choice) => choice.title === title)?.const)
    if (values.some((value) => value === undefined)) return undefined
    if (field.type === 'boolean') content[key] = values[0] === 'true'
    else if (field.type === 'array') content[key] = values
    else content[key] = values[0]
  }
  const missing = (schema.required ?? []).some((key) => content[key] === undefined)
  return missing ? undefined : content
}
