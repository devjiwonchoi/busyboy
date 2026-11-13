// Turns Claude Agent SDK messages and permission requests into contract
// events. Shared by the live adapter and the scripted replay of recorded
// Claude runs, so a recording exercises the same mapping as a real run.
import type { AgentEvent, Question } from './contract'

/** The subset of SDK messages the mapping reads. Recordings keep only these. */
export type ClaudeRawMessage = {
  type: string
  subtype?: string
  session_id?: string
  error?: string
  is_error?: boolean
  result?: string
  errors?: string[]
  event?: { type?: string; delta?: { type?: string; text?: string } }
  message?: { content?: unknown }
  parent_tool_use_id?: string | null
}

/** A `canUseTool` call, as the adapter receives it and as recordings store it. */
export type ClaudePermissionRequest = {
  toolName: string
  input: Record<string, unknown>
  title?: string
  description?: string
}

const SIGNED_OUT_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed'])
const LABEL_LIMIT = 80

function shorten(value: string) {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > LABEL_LIMIT ? `${line.slice(0, LABEL_LIMIT - 1)}…` : line
}

/** A short label such as `Bash: pnpm test` or `Read: app/page.tsx`. */
export function toolLabel(name: string, input: Record<string, unknown>) {
  const detail =
    input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description
  return typeof detail === 'string' && detail ? `${name}: ${shorten(detail)}` : name
}

type ContentBlock = { type?: string; text?: string; name?: string; input?: Record<string, unknown> }

export function claudeMessageToEvents(message: ClaudeRawMessage): AgentEvent[] {
  // Subagent traffic stays inside the subagent; the parent reports its result.
  if (message.parent_tool_use_id) return []
  switch (message.type) {
    case 'system':
      return message.subtype === 'init' && message.session_id ? [{ type: 'session', sessionId: message.session_id }] : []
    case 'stream_event': {
      const { event } = message
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        return [{ type: 'text-delta', text: event.delta.text }]
      }
      return []
    }
    case 'assistant': {
      const events: AgentEvent[] = []
      if (message.error && SIGNED_OUT_ERRORS.has(message.error)) {
        events.push({ type: 'error', code: 'signed-out', message: 'Claude is not signed in. Run `claude` and use /login.' })
      }
      const blocks = Array.isArray(message.message?.content) ? (message.message.content as ContentBlock[]) : []
      const text = blocks
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => block.text)
        .join('')
      if (text && !message.error) events.push({ type: 'text', text })
      for (const block of blocks) {
        if (block.type === 'tool_use' && block.name && block.name !== 'AskUserQuestion') {
          events.push({ type: 'tool', label: toolLabel(block.name, block.input ?? {}) })
        }
      }
      return events
    }
    case 'result': {
      const events: AgentEvent[] = []
      if (message.subtype !== 'success' && message.errors?.length) {
        events.push({ type: 'error', code: 'provider', message: message.errors.join('\n') })
      }
      events.push({ type: 'turn-done' })
      return events
    }
    default:
      return []
  }
}

export function claudePermissionToEvent(
  requestId: string,
  request: ClaudePermissionRequest,
): Extract<AgentEvent, { type: 'approval' | 'question' }> {
  if (request.toolName === 'AskUserQuestion' && Array.isArray(request.input.questions)) {
    const questions = (request.input.questions as Question[]).map((question) => ({
      question: question.question,
      header: question.header,
      multiSelect: Boolean(question.multiSelect),
      options: question.options.map(({ label, description }) => ({ label, description })),
    }))
    return { type: 'question', requestId, questions }
  }
  return {
    type: 'approval',
    requestId,
    title: request.title ?? `Allow ${toolLabel(request.toolName, request.input)}?`,
    detail: request.description,
  }
}
